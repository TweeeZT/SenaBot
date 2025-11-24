import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType
} from '@discordjs/voice';
import { EmbedBuilder } from 'discord.js';
import playdl from 'play-dl';
import ytdlp from 'yt-dlp-exec';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

const MAX_PLAYLIST_LENGTH = Math.max(1, Number(process.env.MAX_PLAYLIST_LENGTH || '400') || 400);

function isYouTubeUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    return /(^|\.)youtube\.com$/.test(url.hostname) || url.hostname === 'youtu.be' || /(^|\.)music\.youtube\.com$/.test(url.hostname);
  } catch { return false; }
}

function ensureVideoUrl(obj) {
  if (!obj) return null;
  if (obj.url && typeof obj.url === 'string') return obj.url;
  const id = obj.id || obj.videoId || obj.video_id;
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return null;
}

function formatDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return null;
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = v => String(v).padStart(2, '0');
  if (h) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function buildProgressBar(elapsed, total) {
  if (!total || total <= 0) return null;
  const ratio = Math.min(1, Math.max(0, (elapsed || 0) / total));
  const length = 20;
  const filled = Math.round(ratio * length);
  const bar = '█'.repeat(filled) + '░'.repeat(length - filled);
  const elapsedLabel = formatDuration(elapsed ?? 0) || '0:00';
  const totalLabel = formatDuration(total) || '0:00';
  return `[${bar}] ${elapsedLabel} / ${totalLabel} (${Math.round(ratio * 100)}%)`;
}

function extractThumbnail(candidate) {
  if (!candidate) return null;
  if (typeof candidate === 'string') return candidate;
  if (Array.isArray(candidate)) {
    for (let i = candidate.length - 1; i >= 0; i -= 1) {
      const chosen = extractThumbnail(candidate[i]);
      if (chosen) return chosen;
    }
    return null;
  }
  if (candidate.url) return candidate.url;
  if (candidate.thumbnails) return extractThumbnail(candidate.thumbnails);
  return null;
}

class GuildQueue {
  constructor(guildId, textChannel) {
    this.guildId = guildId;
    this.textChannel = textChannel;
    this.songs = [];
    this.connection = null;
    this.player = createAudioPlayer();
    this.paused = false;
    // Playback timing tracking for progress bar
    this.currentStartMs = 0; // when current track started/resumed
    this.pausedAtMs = null;  // when paused started
    this.accumulatedPauseMs = 0; // total paused duration for current track
    this.nowPlayingMessage = null;
    this.nowPlayingInterval = null;
    this.currentResource = null; // Track current audio resource
    this.isTransitioning = false; // Prevent duplicate transitions
    this._wirePlayerEvents();
  }

  _wirePlayerEvents() {
    this.player.on(AudioPlayerStatus.Idle, () => {
      // Prevent duplicate processing during transitions
      if (this.isTransitioning) {
        console.log('[AudioPlayer] Skipping Idle event during transition');
        return;
      }
      
      // Only process if we actually have a current song that just finished
      if (this.songs.length === 0) {
        console.log('[AudioPlayer] Idle with empty queue');
        return;
      }
      
      console.log('[AudioPlayer] Song finished, moving to next');
      this.isTransitioning = true;
      this.songs.shift();
      // Reset timing for next track
      this.currentStartMs = 0;
      this.pausedAtMs = null;
      this.accumulatedPauseMs = 0;
      this.currentResource = null;
      this._clearNowPlayingMessage();
      
      if (this.songs.length) {
        setImmediate(() => {
          this.isTransitioning = false;
          this._playCurrent();
        });
      } else {
        this.isTransitioning = false;
        this.textChannel.send('Queue ended.');
      }
    });
    this.player.on('error', e => {
      console.error('[AudioPlayer] Error:', e.message);
      console.error('[AudioPlayer] Error details:', e);
      
      // Check if this is a transient stream error vs real playback failure
      const isStreamError = e.message === 'aborted' || 
                           e.message.includes('aborted') || 
                           e.message.includes('premature close') ||
                           e.message.includes('socket hang up');
      
      if (isStreamError) {
        console.log('[AudioPlayer] Stream error detected, not skipping track');
        // Don't skip the song - let it transition naturally via Idle event
        return;
      }
      
      console.log('[AudioPlayer] Real playback error, skipping track');
      this.textChannel.send(`Playback error: ${e.message}`);
      this.isTransitioning = true;
      this.songs.shift();
      if (this.songs.length) {
        setImmediate(() => {
          this.isTransitioning = false;
          this._playCurrent();
        });
      } else {
        this.isTransitioning = false;
      }
    });
    this.player.on('stateChange', (o,n) => console.log('[AudioPlayer]', o.status, '=>', n.status));
  }

  _buildNowPlayingEmbed(current) {
    const embed = new EmbedBuilder()
      .setColor(0xffc6e6)
      .setTitle('🎶 Now Playing')
      .setDescription(`**${current.title}**`)
      .addFields(
        { name: 'Artist', value: current.artist || 'Unknown', inline: true },
        { name: 'Duration', value: formatDuration(current.duration) || 'Unknown', inline: true },
        { name: 'Requested By', value: current.requestedBy || 'Unknown', inline: true },
      );

    const elapsed = this.getElapsedSeconds();
    const progress = current.duration ? buildProgressBar(elapsed, current.duration) : null;
    if (progress) embed.addFields({ name: 'Progress', value: progress });
    else if (elapsed) {
      const elapsedLabel = formatDuration(elapsed) || '0:00';
      embed.addFields({ name: 'Elapsed', value: elapsedLabel });
    }

    const upcoming = this.songs[1];
    if (upcoming) {
      embed.addFields({
        name: 'Up Next',
        value: `**${upcoming.title}**\n${upcoming.artist || 'Unknown'} • ${formatDuration(upcoming.duration) || '?'}`,
      });
    }

    if (current.thumbnail) embed.setThumbnail(current.thumbnail);
    return embed;
  }

  _stopNowPlayingUpdates() {
    if (this.nowPlayingInterval) {
      clearInterval(this.nowPlayingInterval);
      this.nowPlayingInterval = null;
    }
  }

  _startNowPlayingUpdater() {
    this._stopNowPlayingUpdates();
    if (!this.nowPlayingMessage) return;
    this.nowPlayingInterval = setInterval(() => {
      this._updateNowPlayingMessage().catch(err => console.error('[now playing update] failed', err));
    }, 15_000);
    this.nowPlayingInterval.unref?.();
  }

  async _updateNowPlayingMessage() {
    if (!this.nowPlayingMessage) return;
    const current = this.songs[0];
    if (!current) {
      this._clearNowPlayingMessage();
      return;
    }
    try {
      const embed = this._buildNowPlayingEmbed(current);
      await this.nowPlayingMessage.edit({ embeds: [embed] });
    } catch (err) {
      console.error('[now playing edit] failed', err);
      this._clearNowPlayingMessage();
    }
  }

  _clearNowPlayingMessage() {
    this._stopNowPlayingUpdates();
    this.nowPlayingMessage = null;
  }

  async _sendNowPlayingEmbed(current) {
    if (!current) return;
    this._stopNowPlayingUpdates();
    try {
      const embed = this._buildNowPlayingEmbed(current);
      if (this.nowPlayingMessage) {
        await this.nowPlayingMessage.edit({ embeds: [embed] });
      } else {
        this.nowPlayingMessage = await this.textChannel.send({ embeds: [embed] });
      }
      this._startNowPlayingUpdater();
    } catch (err) {
      console.error('[now playing embed] failed to send', err);
      this._clearNowPlayingMessage();
    }
  }

  async connect(voiceChannel) {
    if (this.connection) return;
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator
    });
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (e) {
      console.error('Voice connection failed:', e);
      this.textChannel.send('Failed to join voice channel.');
      this.connection.destroy();
      this.connection = null;
    }
    if (this.connection) this.connection.subscribe(this.player);
  }

  async add(query, member) {
    if (!query || typeof query !== 'string') throw new Error('Empty query');
    const requestedBy = member?.displayName || member?.nickname || member?.user?.username || 'Unknown';
    const ctx = { query };
    let url = null;
    let title = null;
    const meta = { duration: null, thumbnail: null, artist: null };
    try {
      if (/spotify\.com|spoti\.fi/.test(query)) {
        const info = await playdl.spotify(query);
        ctx.spotifyType = info?.type;
        if (info?.type === 'track') {
          const terms = `${info.name} ${info.artists.map(a=>a.name).join(' ')}`;
          const res = await playdl.search(terms, { limit:1 });
          ctx.search = { terms, count: res.length };
          if (!res.length) throw new Error('No YouTube match for Spotify track');
          url = ensureVideoUrl(res[0]);
          title = res[0].title || info.name;
          meta.artist = info.artists?.[0]?.name || null;
        } else if (info?.type === 'playlist') {
          const first = info.tracks?.[0];
          if (!first) throw new Error('Empty Spotify playlist');
          const terms = `${first.name} ${first.artists.map(a=>a.name).join(' ')}`;
          const res = await playdl.search(terms, { limit:1 });
          ctx.search = { terms, count: res.length };
          if (!res.length) throw new Error('No YouTube match for first playlist track');
          url = ensureVideoUrl(res[0]);
          title = res[0].title || first.name;
          meta.artist = first.artists?.[0]?.name || null;
        } else throw new Error('Unsupported Spotify resource');
      } else if (/^https?:\/\//i.test(query)) {
        if (!isYouTubeUrl(query)) throw new Error('Only YouTube URLs supported');
        if (/list=/.test(query)) {
          ctx.youtubePlaylist = true;
          return await this._queueYouTubePlaylist(query, requestedBy, ctx);
        }
        url = query;
        try {
          const info = await playdl.video_basic_info(query);
          title = info?.video_details?.title || query;
          meta.artist = meta.artist || info?.video_details?.channel?.name || info?.video_details?.author?.name || null;
        } catch {
          title = query;
        }
      } else {
        const res = await playdl.search(query, { limit:1 });
        ctx.search = { terms: query, count: res.length };
        if (!res.length) throw new Error('No search results');
        url = ensureVideoUrl(res[0]);
        title = res[0].title || query;
        meta.artist = res[0].channel?.name || res[0].author?.name || null;
      }
    } catch (e) {
      console.warn('add() context:', ctx);
      throw new Error('Search failed: ' + e.message);
    }
    if (!url || !isYouTubeUrl(url)) throw new Error('Unplayable URL');

    // Metadata extraction (best-effort; won't fail add if it errors)
    try {
      const disablePlaydl = process.env.DISABLE_PLAYDL === '1' || process.env.NO_PLAYDL === '1';
      if (!disablePlaydl) {
        const info = await playdl.video_basic_info(url);
        const vd = info?.video_details;
        meta.duration = vd?.durationInSec || null;
        meta.artist = meta.artist || vd?.channel?.name || vd?.author?.name || null;
        const thumbs = vd?.thumbnails || vd?.thumbnail?.thumbnails || [];
        if (Array.isArray(thumbs) && thumbs.length) meta.thumbnail = thumbs.slice(-1)[0].url || thumbs[0].url;
      }
      if (!meta.duration || !meta.thumbnail || !meta.artist) {
        const json = await ytdlp(url, { dumpSingleJson: true, noWarnings: true, skipDownload: true, noCallHome: true, format: 'bestaudio/best' });
        meta.duration = meta.duration || json?.duration || json?.duration_string?.split(':').reduce((acc,v)=>acc*60+Number(v),0) || null;
        meta.artist = meta.artist || json?.uploader || json?.channel || null;
        if (!meta.thumbnail) {
          meta.thumbnail = json?.thumbnail || (Array.isArray(json?.thumbnails) ? json.thumbnails.slice(-1)[0].url : null);
        }
      }
    } catch (mErr) {
      console.warn('Metadata extraction failed (non-fatal):', mErr.message);
    }

    console.log('Queue add resolved:', { url, title });
    this.songs.push({ title, url, requestedBy, duration: meta.duration, thumbnail: meta.thumbnail, artist: meta.artist });
    if (this.player.state.status === AudioPlayerStatus.Idle) await this._playCurrent();
    return { type: 'track', track: { title, url, duration: meta.duration, thumbnail: meta.thumbnail, artist: meta.artist } };
  }

  _createTrackFromPlaylistVideo(video, requestedBy, fallbackTitle) {
    const videoUrl = ensureVideoUrl(video);
    if (!videoUrl || !isYouTubeUrl(videoUrl)) return null;
    const duration = typeof video.durationInSec === 'number'
      ? video.durationInSec
      : (typeof video.duration === 'number' ? video.duration : null);
    const thumbnail = extractThumbnail(video.thumbnails || video.thumbnail);
    const artist = video.channel?.name || video.channel?.title || video.author?.name || video.author?.title || null;
    return {
      title: video.title || fallbackTitle || 'Untitled',
      url: videoUrl,
      requestedBy,
      duration,
      thumbnail,
      artist,
    };
  }

  async _queueYouTubePlaylist(query, requestedBy, ctx) {
    let collected = [];
    let playlistTitle = 'YouTube Playlist';
    
    // Try play-dl first
    try {
      const playlist = await playdl.playlist_info(query, { incomplete: true });
      const fetchLimit = Math.min(500, MAX_PLAYLIST_LENGTH + 100);
      await playlist.fetch(fetchLimit);

      if (playlist?.fetched_videos instanceof Map) {
        for (const page of playlist.fetched_videos.values()) {
          for (const video of page) {
            collected.push(video);
            if (collected.length >= MAX_PLAYLIST_LENGTH) break;
          }
          if (collected.length >= MAX_PLAYLIST_LENGTH) break;
        }
      }
      if (!collected.length && Array.isArray(playlist?.videos)) {
        collected.push(...playlist.videos.slice(0, MAX_PLAYLIST_LENGTH));
      }
      playlistTitle = playlist.title || playlistTitle;
    } catch (playdlErr) {
      console.warn('[playlist] play-dl failed, trying yt-dlp fallback:', playdlErr.message);
      
      // Fallback to yt-dlp for large/problematic playlists
      try {
        const ytdlpData = await ytdlp(query, {
          dumpSingleJson: true,
          flatPlaylist: true,
          noWarnings: true,
          skipDownload: true,
          playlistEnd: MAX_PLAYLIST_LENGTH
        });
        
        playlistTitle = ytdlpData.title || playlistTitle;
        const entries = ytdlpData.entries || [];
        
        for (const entry of entries.slice(0, MAX_PLAYLIST_LENGTH)) {
          if (entry && entry.id) {
            collected.push({
              id: entry.id,
              title: entry.title || 'Unknown',
              durationInSec: entry.duration || null,
              thumbnails: entry.thumbnails || [],
              channel: { name: entry.uploader || entry.channel || null }
            });
          }
        }
        console.log(`[playlist] yt-dlp fallback collected ${collected.length} videos`);
      } catch (ytdlpErr) {
        console.error('[playlist] yt-dlp fallback also failed:', ytdlpErr.message);
        throw new Error(`Playlist loading failed: ${playdlErr.message}`);
      }
    }

    if (!collected.length) throw new Error('Playlist has no videos');

    ctx.playlistVideoCount = collected.length;
    const tracks = [];
    for (const video of collected) {
      const track = this._createTrackFromPlaylistVideo(video, requestedBy, playlistTitle);
      if (track) tracks.push(track);
    }
    if (!tracks.length) throw new Error('Playlist has no playable videos');

    this.songs.push(...tracks);
    console.log('Queued playlist:', { title: playlistTitle, added: tracks.length, total: collected.length });
    if (this.player.state.status === AudioPlayerStatus.Idle) await this._playCurrent();
    return {
      type: 'playlist',
      title: playlistTitle,
      trackCount: tracks.length,
      firstTrack: tracks[0],
    };
  }

  async _playCurrent() {
    const current = this.songs[0];
    console.log('Attempting playback:', current);
    if (!current) return;
    if (!current.url || !isYouTubeUrl(current.url)) {
      this.textChannel.send('Invalid URL, skipping…');
      this.songs.shift();
      this._clearNowPlayingMessage();
      if (this.songs.length) {
        setImmediate(() => this._playCurrent());
      }
      return;
    }
    // Initialize timing for new track
    this.currentStartMs = Date.now();
    this.pausedAtMs = null;
    this.accumulatedPauseMs = 0;
    this.paused = false;
    this.isTransitioning = false;
    const disablePlaydl = process.env.DISABLE_PLAYDL === '1' || process.env.NO_PLAYDL === '1';
    const announce = () => this._sendNowPlayingEmbed(current);
    if (!disablePlaydl) {
      // Primary
      try {
        const s = await playdl.stream(current.url);
        const r = createAudioResource(s.stream, { 
          inputType: s.type,
          inlineVolume: true
        });
        r.volume?.setVolume(1.0);
        s.stream.on('error', err => {
          if (err.message !== 'aborted' && !err.message.includes('premature')) {
            console.error('[stream error]', err);
          }
        });
        this.currentResource = r; // Keep reference to prevent GC
        this.player.play(r);
        console.log('[playback] Started via play-dl primary method');
        announce();
        return;
      } catch (e) { console.error('[primary fail]', e.message); }
      // Info fallback
      try {
        const info = await playdl.video_basic_info(current.url);
        const s = await playdl.stream_from_info(info);
        const r = createAudioResource(s.stream, { 
          inputType: s.type,
          inlineVolume: true
        });
        r.volume?.setVolume(1.0);
        s.stream.on('error', err => {
          if (err.message !== 'aborted' && !err.message.includes('premature')) {
            console.error('[stream error]', err);
          }
        });
        this.currentResource = r; // Keep reference to prevent GC
        this.player.play(r);
        console.log('[playback] Started via play-dl info fallback');
        announce();
        return;
      } catch (e) { console.error('[info fallback fail]', e.message); }
    } else {
      console.log('Play-dl disabled via env flag, skipping primary fallbacks');
    }
    // yt-dlp extraction
    let direct = null;
    try {
      const json = await ytdlp(current.url, { dumpSingleJson:true, noWarnings:true, skipDownload:true, noCallHome:true, format:'bestaudio/best' });
      direct = json?.url;
      if (!direct && Array.isArray(json?.requested_formats)) direct = json.requested_formats.find(f=>f?.url)?.url;
      if (!direct && Array.isArray(json?.formats)) {
        const best = json.formats.filter(f=>/audio/i.test(f?.acodec) && !/video/i.test(f?.vcodec)).slice(-1)[0];
        direct = best?.url;
      }
      if (direct) console.log('[yt-dlp] direct url length:', direct.length);
    } catch(e){ console.error('[yt-dlp fail]', e.message); }
    if (direct) {
      // Skip direct stream - it's unreliable and drops connection mid-playback
      // Use ffmpeg to properly buffer and transcode the stream
      // ffmpeg encode
      try {
        const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic;
        const args = [
          '-reconnect', '1',
          '-reconnect_streamed', '1', 
          '-reconnect_delay_max', '5',
          '-i', direct,
          '-analyzeduration', '0',
          '-loglevel', 'error',
          '-vn',
          '-c:a', 'libopus',
          '-b:a', '128k',
          '-f', 'ogg',
          'pipe:1'
        ];
        console.log('[ffmpeg encode] spawning with reconnect support...');
        const proc = spawn(ffmpegPath, args, { stdio:['ignore','pipe','pipe'] });
        proc.stderr.on('data', d=>{ const m=d.toString().trim(); if(m) console.warn('[ffmpeg]', m); });
        proc.on('error', err=>console.error('[ffmpeg proc error]', err));
        proc.on('close', code=>{ if(code!==0) console.warn('[ffmpeg exit]', code); });
        proc.stdout.on('error', err => {
          if (err.message !== 'aborted') console.error('[ffmpeg stdout error]', err);
        });
        const r = createAudioResource(proc.stdout, { 
          inputType: StreamType.OggOpus,
          inlineVolume: true
        });
        r.volume?.setVolume(1.0);
        this.currentResource = r; // Keep reference to prevent GC
        this.player.play(r);
        console.log('[playback] Started via ffmpeg transcode');
        announce();
        return;
      } catch(e){ console.error('[ffmpeg encode fail]', e.message); }
    }
    this.textChannel.send('All playback methods failed, skipping…');
    this.songs.shift();
    this._clearNowPlayingMessage();
    if (this.songs.length) {
      setImmediate(() => this._playCurrent());
    }
  }

  skip() {
    if (!this.songs.length) return false;
    this.player.stop();
    return true;
  }
  stop() {
    this.songs = [];
    this.player.stop();
    this._clearNowPlayingMessage();
    this.textChannel.send('⏹️ Stopped and cleared queue.');
  }
  pause() {
    if (this.player.pause()) {
      if (!this.paused) {
        this.pausedAtMs = Date.now();
        this.paused = true;
      }
      this._updateNowPlayingMessage().catch(() => {});
      return true;
    }
    return false;
  }
  resume() {
    if (this.player.unpause()) {
      if (this.pausedAtMs) {
        this.accumulatedPauseMs += Date.now() - this.pausedAtMs;
        this.pausedAtMs = null;
      }
      this.paused = false;
      this._updateNowPlayingMessage().catch(() => {});
      return true;
    }
    return false;
  }
  shuffle() { const [first,...rest]=this.songs; for(let i=rest.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [rest[i],rest[j]]=[rest[j],rest[i]];} this.songs=[first,...rest]; }
  remove(index){ if(index<=0||index>=this.songs.length) return null; const [r]=this.songs.splice(index,1); return r; }

  getElapsedSeconds() {
    if (!this.currentStartMs) return 0;
    const now = this.paused && this.pausedAtMs ? this.pausedAtMs : Date.now();
    const elapsed = (now - this.currentStartMs - this.accumulatedPauseMs) / 1000;
    return elapsed < 0 ? 0 : elapsed;
  }
}

export class PlayerManager {
  constructor(){ this.queues=new Map(); }
  get(guildId, textChannel){ let q=this.queues.get(guildId); if(!q){ q=new GuildQueue(guildId,textChannel); this.queues.set(guildId,q);} return q; }
}

export const playerManager = new PlayerManager();
