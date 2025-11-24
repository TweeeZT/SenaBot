import {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    Routes,
    EmbedBuilder,
    PermissionsBitField,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    ActivityType
} from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import { REST } from '@discordjs/rest';
import { generateDependencyReport } from '@discordjs/voice';
import ffmpeg from 'ffmpeg-static';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import { playerManager } from './player.js';
import youtubedl from 'yt-dlp-exec';
import crypto from 'node:crypto';
import fetch from 'node-fetch';

// Suppress harmless Node.js warnings from Discord.js internals
process.removeAllListeners('warning');
process.on('warning', (warning) => {
    if (warning.name === 'TimeoutNegativeWarning') return; // Ignore timeout warnings from audio streams
    console.warn(warning);
});

dotenv.config();

// osu! configuration (single tracked user)
const OSU_CLIENT_ID = process.env.OSU_CLIENT_ID;
const OSU_CLIENT_SECRET = process.env.OSU_CLIENT_SECRET;
const OSU_USERNAME = process.env.OSU_USERNAME; // e.g. tweeezt
const OSU_USER_ID = process.env.OSU_USER_ID;   // e.g. 15181539
const OSU_RECENT_CHANNEL_ID = process.env.OSU_RECENT_CHANNEL_ID || null;
const rawOsuRecentPollSeconds = Number(process.env.OSU_RECENT_POLL_SECONDS);
const OSU_RECENT_POLL_INTERVAL = Math.max(30, Number.isFinite(rawOsuRecentPollSeconds) ? rawOsuRecentPollSeconds : 120) * 1000;

const osuRecentWatcher = {
    channel: null,
    timer: null,
    lastScoreKey: null,
};

const ACTIVITY_TYPE_MAP = new Map([
    ['PLAYING', ActivityType.Playing],
    ['STREAMING', ActivityType.Streaming],
    ['LISTENING', ActivityType.Listening],
    ['WATCHING', ActivityType.Watching],
    ['COMPETING', ActivityType.Competing],
    ['CUSTOM', ActivityType.Custom],
]);

const BOT_STATUS_TEXT = process.env.BOT_STATUS_TEXT ?? 'with tweeezt';
const BOT_STATUS_TYPE = (process.env.BOT_STATUS_TYPE || 'PLAYING').toUpperCase();
const BOT_STATUS_STATE = (process.env.BOT_STATUS_STATE || 'online').toLowerCase();
const BOT_STATUS_STREAM_URL = process.env.BOT_STATUS_STREAM_URL || null;

const VALORANT_NAME = process.env.VALORANT_NAME || null;
const VALORANT_TAG = process.env.VALORANT_TAG || null;
const VALORANT_REGION = (process.env.VALORANT_REGION || 'ap').toLowerCase();

// Tracker.gg API (primary, requires approval)
const TRACKER_GG_API_BASE = 'https://api.tracker.gg/api/v2/valorant';
const rawTrackerKey = (process.env.TRACKER_GG_API_KEY || '').trim();
const TRACKER_GG_API_KEY = rawTrackerKey.length ? rawTrackerKey : null;

// Henrik API (fallback, free, no approval needed)
const HENRIK_API_BASE = 'https://api.henrikdev.xyz/valorant';
const rawHenrikKey = (process.env.HENRIK_API_KEY || '').trim();
const HENRIK_API_KEY = rawHenrikKey.length ? rawHenrikKey : null;

let osuTokenCache = {
    token: null,
    expiresAt: 0,
};

async function getOsuAccessToken() {
    const now = Date.now();
    if (osuTokenCache.token && now < osuTokenCache.expiresAt) {
        return osuTokenCache.token;
    }

    if (!OSU_CLIENT_ID || !OSU_CLIENT_SECRET) {
        throw new Error('OSU_CLIENT_ID or OSU_CLIENT_SECRET is not set in .env');
    }

    const params = new URLSearchParams();
    params.append('client_id', OSU_CLIENT_ID);
    params.append('client_secret', OSU_CLIENT_SECRET);
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'public');

    const res = await fetch('https://osu.ppy.sh/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to get osu token: ${res.status} ${text}`);
    }

    const data = await res.json();
    osuTokenCache.token = data.access_token;
    osuTokenCache.expiresAt = Date.now() + (data.expires_in - 30) * 1000;
    return osuTokenCache.token;
}

async function fetchOsuUser(mode = 'osu') {
    const identifier = OSU_USER_ID || OSU_USERNAME;
    if (!identifier) {
        throw new Error('OSU_USER_ID or OSU_USERNAME is not set in .env');
    }
    const token = await getOsuAccessToken();

    const url = `https://osu.ppy.sh/api/v2/users/${encodeURIComponent(identifier)}/${mode}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to fetch osu user: ${res.status} ${text}`);
    }
    return res.json();
}

async function fetchOsuRecent(mode = 'osu') {
    const userId = OSU_USER_ID || OSU_USERNAME;
    if (!userId) {
        throw new Error('OSU_USER_ID or OSU_USERNAME is not set in .env');
    }
    const token = await getOsuAccessToken();

    const url = `https://osu.ppy.sh/api/v2/users/${encodeURIComponent(userId)}/scores/recent?include_fails=1&limit=1&mode=${mode}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to fetch osu recent: ${res.status} ${text}`);
    }
    return res.json();
}

async function fetchOsuTopScores(limit = 5, mode = 'osu', offset = 0) {
    const userId = OSU_USER_ID || OSU_USERNAME;
    if (!userId) {
        throw new Error('OSU_USER_ID or OSU_USERNAME is not set in .env');
    }
    const token = await getOsuAccessToken();
    const safeLimit = Math.min(Math.max(limit || 5, 1), 100);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const url = `https://osu.ppy.sh/api/v2/users/${encodeURIComponent(userId)}/scores/best?mode=${mode}&limit=${safeLimit}&offset=${safeOffset}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to fetch osu top scores: ${res.status} ${text}`);
    }
    return res.json();
}

// Dual Valorant API functions (Tracker.gg primary, Henrik fallback)
let valorantApiKeyWarned = false;

async function trackerGgApiFetch(endpoint) {
    if (!TRACKER_GG_API_KEY) throw new Error('TRACKER_GG_API_KEY not configured');
    const url = `${TRACKER_GG_API_BASE}${endpoint}`;
    const res = await fetch(url, {
        headers: {
            'TRN-Api-Key': TRACKER_GG_API_KEY,
            'User-Agent': 'SenaDiscordBot/1.0'
        }
    });
    if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Tracker.gg API ${res.status}: ${errorText || res.statusText}`);
    }
    return res.json();
}

async function henrikApiFetch(path, searchParams = null) {
    const url = new URL(`${HENRIK_API_BASE}${path}`);
    if (searchParams && typeof searchParams === 'object') {
        for (const [key, value] of Object.entries(searchParams)) {
            if (value != null) url.searchParams.set(key, value);
        }
    }

    const headers = {
        'User-Agent': 'SenaBot/1.0 Valorant',
        'Accept': '*/*',
    };
    if (HENRIK_API_KEY) {
        headers.Authorization = HENRIK_API_KEY;
    } else if (!valorantApiKeyWarned) {
        console.warn('[valorant] No Henrik API key set. Rate limits may apply. Set HENRIK_API_KEY in .env for higher limits.');
        valorantApiKeyWarned = true;
    }

    const res = await fetch(url, { headers });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const isError = !res.ok || (parsed && parsed.status && parsed.status !== 200);
    if (isError) {
        const message = parsed?.errors?.[0]?.message || parsed?.message || text;
        throw new Error(`Henrik API ${res.status}: ${message}`);
    }
    return parsed;
}

async function fetchValorantAccount() {
    if (!VALORANT_NAME || !VALORANT_TAG) {
        throw new Error('VALORANT_NAME or VALORANT_TAG is not set in .env');
    }
    // Try Tracker.gg first
    if (TRACKER_GG_API_KEY) {
        try {
            return await trackerGgApiFetch(`/standard/profile/riot/${encodeURIComponent(VALORANT_NAME)}%23${encodeURIComponent(VALORANT_TAG)}`);
        } catch (err) {
            console.warn('[Valorant] Tracker.gg account fetch failed, falling back to Henrik:', err.message);
        }
    }
    // Fallback to Henrik
    return henrikApiFetch(`/v2/account/${encodeURIComponent(VALORANT_NAME)}/${encodeURIComponent(VALORANT_TAG)}`);
}

async function fetchValorantMMR() {
    if (!VALORANT_NAME || !VALORANT_TAG) {
        throw new Error('VALORANT_NAME or VALORANT_TAG is not set in .env');
    }
    // Try Tracker.gg first (embedded in profile)
    if (TRACKER_GG_API_KEY) {
        try {
            const data = await trackerGgApiFetch(`/standard/profile/riot/${encodeURIComponent(VALORANT_NAME)}%23${encodeURIComponent(VALORANT_TAG)}`);
            // Transform Tracker.gg format to Henrik-like format
            const segments = data?.data?.segments || [];
            const overviewSegment = segments.find(s => s.type === 'overview');
            if (overviewSegment) {
                const stats = overviewSegment.stats || {};
                return {
                    data: {
                        currenttierpatched: stats.rank?.metadata?.tierName || 'Unranked',
                        ranking_in_tier: stats.rr?.value || 0,
                        elo: stats.peakRating?.value || 0,
                        mmr_change_to_last_game: 0 // Tracker.gg doesn't provide this easily
                    }
                };
            }
        } catch (err) {
            console.warn('[Valorant] Tracker.gg MMR fetch failed, falling back to Henrik:', err.message);
        }
    }
    // Fallback to Henrik
    return henrikApiFetch(`/v2/mmr/${encodeURIComponent(VALORANT_REGION)}/${encodeURIComponent(VALORANT_NAME)}/${encodeURIComponent(VALORANT_TAG)}`);
}

async function fetchValorantRecentMatches(limit = 1) {
    if (!VALORANT_NAME || !VALORANT_TAG) {
        throw new Error('VALORANT_NAME or VALORANT_TAG is not set in .env');
    }
    const capped = Math.min(Math.max(limit || 1, 1), 5);
    // Try Tracker.gg first
    if (TRACKER_GG_API_KEY) {
        try {
            const data = await trackerGgApiFetch(`/standard/matches/riot/${encodeURIComponent(VALORANT_NAME)}%23${encodeURIComponent(VALORANT_TAG)}`);
            // Transform to Henrik-like format
            const matches = data?.data?.matches || [];
            return {
                data: matches.slice(0, capped).map(m => ({
                    metadata: {
                        map: m.metadata?.mapName || 'Unknown',
                        mode: m.metadata?.modeName || 'Unknown',
                        rounds_played: m.segments?.[0]?.stats?.roundsPlayed?.value || 0,
                        game_start: m.metadata?.timestamp
                    },
                    players: {
                        all_players: m.segments || []
                    },
                    teams: {
                        red: { has_won: m.segments?.[0]?.metadata?.result === 'win', rounds_won: m.segments?.[0]?.stats?.score?.value || 0 },
                        blue: { has_won: m.segments?.[0]?.metadata?.result === 'loss', rounds_won: 0 }
                    }
                }))
            };
        } catch (err) {
            console.warn('[Valorant] Tracker.gg matches fetch failed, falling back to Henrik:', err.message);
        }
    }
    // Fallback to Henrik
    return henrikApiFetch(`/v3/matches/${encodeURIComponent(VALORANT_REGION)}/${encodeURIComponent(VALORANT_NAME)}/${encodeURIComponent(VALORANT_TAG)}`, { size: capped });
}

function findConfiguredValorantPlayer(match) {
    if (!match?.players?.all_players || !VALORANT_NAME || !VALORANT_TAG) return null;
    const targetName = VALORANT_NAME.toLowerCase();
    const targetTag = VALORANT_TAG.toLowerCase();
    return match.players.all_players.find(player =>
        player?.name?.toLowerCase() === targetName && player?.tag?.toLowerCase() === targetTag
    ) || null;
}

function summarizeValorantMatches(matches) {
    const summary = {
        games: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        damage: 0,
        damageReceived: 0,
        headshots: 0,
        bodyshots: 0,
        legshots: 0,
        rounds: 0,
        roundsWon: 0,
        roundsLost: 0,
        totalScore: 0,
        agentCounts: new Map(),
        mapCounts: new Map(),
        queueCounts: new Map(),
    };
    for (const match of matches || []) {
        const player = findConfiguredValorantPlayer(match);
        if (!player) continue;
        summary.games += 1;
        const stats = player.stats || {};
        summary.kills += stats.kills ?? player.kills ?? 0;
        summary.deaths += stats.deaths ?? player.deaths ?? 0;
        summary.assists += stats.assists ?? player.assists ?? 0;
        summary.damage += player.damage_made ?? 0;
        summary.damageReceived += player.damage_received ?? 0;
        const shots = stats.shots || {};
        summary.headshots += shots.head ?? 0;
        summary.bodyshots += shots.body ?? 0;
        summary.legshots += shots.leg ?? 0;
        summary.rounds += match.metadata?.rounds_played ?? 0;
        const teamKey = (player.team || '').toLowerCase();
        const teamStats = match.teams?.[teamKey];
        if (teamStats?.has_won) summary.wins += 1;
        summary.roundsWon += teamStats?.rounds_won ?? 0;
        const opponentKey = teamKey === 'red' ? 'blue' : 'red';
        summary.roundsLost += match.teams?.[opponentKey]?.rounds_won ?? 0;
        summary.totalScore += stats.score ?? 0;

        const agentName = player.character || 'Unknown agent';
        const mapName = match.metadata?.map || 'Unknown map';
        const queueName = match.metadata?.queue || match.metadata?.mode || 'Unknown mode';
        incrementCount(summary.agentCounts, agentName);
        incrementCount(summary.mapCounts, mapName);
        incrementCount(summary.queueCounts, queueName);
    }
    return summary;
}

function formatPerc(value, digits = 1) {
    if (!Number.isFinite(value)) return 'N/A';
    return `${value.toFixed(digits)}%`;
}

function formatDiscordTimestamp(value) {
    if (!value) return 'Unknown time';
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(ms)) return 'Unknown time';
    return `<t:${Math.floor(ms / 1000)}:R>`;
}

function formatValorantScoreboardLines(match, limit = 4) {
    const players = match?.players?.all_players;
    if (!Array.isArray(players) || !players.length) return 'No scoreboard data available.';
    const sorted = [...players].sort((a, b) => {
        const killsA = a.stats?.kills ?? a.kills ?? 0;
        const killsB = b.stats?.kills ?? b.kills ?? 0;
        const scoreA = a.stats?.score ?? 0;
        const scoreB = b.stats?.score ?? 0;
        if (killsB !== killsA) return killsB - killsA;
        return scoreB - scoreA;
    });
    return sorted.slice(0, limit).map(player => {
        const stats = player.stats || {};
        const teamInitial = (player.team || '?').charAt(0).toUpperCase();
        return `${teamInitial} • ${player.name}#${player.tag} — ${stats.kills ?? player.kills ?? 0}/${stats.deaths ?? player.deaths ?? 0}/${stats.assists ?? player.assists ?? 0}`;
    }).join('\n');
}

function normalizeImageUrl(value) {
    if (typeof value === 'string' && value.trim().length) {
        return value.trim();
    }
    return null;
}

function incrementCount(map, key) {
    if (!map || !key) return;
    const current = map.get(key) || 0;
    map.set(key, current + 1);
}

function describeTopCounts(map, label = 'entry', limit = 3) {
    if (!map || !map.size) return `No recent ${label}s.`;
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, count], idx) => `${idx + 1}. ${name} (${count})`)
        .join('\n');
}

function formatAverage(total, count, digits = 1) {
    if (!count) return 'N/A';
    const avg = total / count;
    if (!Number.isFinite(avg)) return 'N/A';
    return avg.toFixed(digits);
}

async function fetchOsuBeatmap(beatmapId) {
    if (!beatmapId) throw new Error('No beatmap ID provided');
    const token = await getOsuAccessToken();
    const url = `https://osu.ppy.sh/api/v2/beatmaps/${beatmapId}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to fetch beatmap: ${res.status} ${text}`);
    }
    return res.json();
}

async function fetchOsuBeatmapset(beatmapsetId) {
    if (!beatmapsetId) throw new Error('No beatmapset ID provided');
    const token = await getOsuAccessToken();
    const url = `https://osu.ppy.sh/api/v2/beatmapsets/${beatmapsetId}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to fetch beatmapset: ${res.status} ${text}`);
    }
    return res.json();
}

async function fetchOsuBeatmapAttributes(beatmapId, mods = [], mode = 'osu') {
    if (!beatmapId) throw new Error('No beatmap ID provided');
    const token = await getOsuAccessToken();
    const normalizedMods = Array.isArray(mods) ? mods.filter(Boolean).map(m => String(m).toUpperCase()) : [];

    const url = `https://osu.ppy.sh/api/v2/beatmaps/${beatmapId}/attributes`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mods: normalizedMods, ruleset: mode }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to fetch beatmap attributes: ${res.status} ${text}`);
    }
    return res.json();
}

// --------------------------------------------
//            CLIENT SETUP
// --------------------------------------------
// Attachment size control:
// - Set MAX_ATTACH_MB to a positive number to constrain attachment size (e.g., 8, 25, 50)
// - Set to 0 or omit to lift the cap (bot will try to attach; if too large, it will fall back to a direct link)
const RAW_MAX_ATTACH_MB = process.env.MAX_ATTACH_MB;
const MAX_ATTACH_MB = RAW_MAX_ATTACH_MB === undefined ? 0 : Number(RAW_MAX_ATTACH_MB);
const MAX_ATTACH_BYTES = (Number.isFinite(MAX_ATTACH_MB) && MAX_ATTACH_MB > 0)
    ? Math.max(1, Math.floor(MAX_ATTACH_MB)) * 1024 * 1024
    : Infinity;

// Privileged intent toggle: only request MessageContent when explicitly enabled
const ENABLE_MESSAGE_CONTENT = /^(true|1|yes)$/i.test(process.env.ENABLE_MESSAGE_CONTENT || '');
const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
];
if (ENABLE_MESSAGE_CONTENT) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
// Map to track download button IDs to URLs (ephemeral lifetime)
const downloadRequests = new Map();
const osuTopSessions = new Map();
const OSU_TOP_SESSION_TTL = 10 * 60 * 1000; // 10 minutes

// Utility: format seconds into H:MM:SS or M:SS
function formatDuration(sec) {
    if (!sec || isNaN(sec)) return null;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = v => String(v).padStart(2,'0');
    if (h) return `${h}:${pad(m)}:${pad(s)}`;
    return `${m}:${pad(s)}`;
}

// Progress bar builder (text) length 20 chars
function buildProgressBar(elapsed, total) {
    if (!total || total <= 0 || !elapsed || elapsed < 0) return null;
    const ratio = Math.min(1, elapsed / total);
    const length = 20;
    const filled = Math.round(ratio * length);
    const bar = '█'.repeat(filled) + '░'.repeat(length - filled);
    return `[${bar}] ${formatDuration(elapsed)} / ${formatDuration(total)} (${Math.round(ratio*100)}%)`;
}

// --------------------------------------------
//        Distube (music engine)
    // --------------------------------------------
    //        Custom Player (play-dl based)
    // --------------------------------------------
    // Distube removed; we now use playerManager (player.js) for queue & playback.
// --------------------------------------------
//            SLASH COMMANDS
// --------------------------------------------

const commands = [
    new SlashCommandBuilder()
        .setName("play")
    .setDescription("Play a song from YouTube or Spotify.")
        .addStringOption(o =>
            o.setName("query")
             .setDescription("Song title or link")
             .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("playsong")
        .setDescription("Search for songs and choose from top 3 results.")
        .addStringOption(o =>
            o.setName("query")
             .setDescription("Song title or artist to search for")
             .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("download")
        .setDescription("Download media from social links (<=8MB attach if possible).")
        .addStringOption(o =>
            o.setName("url")
             .setDescription("Media URL (X/Twitter, Reddit, TikTok, Instagram, Facebook)")
             .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("queue")
        .setDescription("Show the current song queue."),

    new SlashCommandBuilder()
        .setName("remove")
        .setDescription("Remove a song from the queue.")
        .addIntegerOption(o =>
            o.setName("index")
             .setDescription("Song number")
             .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("shuffle")
        .setDescription("Shuffle the queue."),

    new SlashCommandBuilder()
        .setName("volume")
        .setDescription("Set volume (1–100).")
        .addIntegerOption(o =>
            o.setName("value")
             .setDescription("Volume %")
             .setRequired(true)
        )

    ,

    new SlashCommandBuilder()
        .setName("skip")
        .setDescription("Skip the currently playing song."),

    new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop playback and clear the queue."),

    new SlashCommandBuilder()
        .setName("pause")
        .setDescription("Pause the currently playing song."),

    new SlashCommandBuilder()
        .setName("resume")
        .setDescription("Resume a paused song."),
    new SlashCommandBuilder()
        .setName("nowplaying")
        .setDescription("Show the currently playing song."),
    new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show a list of available commands."),
    new SlashCommandBuilder()
        .setName("profile")
        .setDescription("Show your Discord profile information."),
    new SlashCommandBuilder()
        .setName("osuprofile")
        .setDescription("Show osu! profile stats for the configured user."),
    new SlashCommandBuilder()
        .setName("osurecent")
        .setDescription("Show the most recent osu! play for the configured user."),
    new SlashCommandBuilder()
        .setName('osutop')
        .setDescription('Show top osu! plays for the configured user')
        .addIntegerOption(option =>
            option.setName('limit')
                .setDescription('How many plays to show (1-10)')
                .setMinValue(1)
                .setMaxValue(25)
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('osumap')
        .setDescription('Show osu! beatmap details and estimated PP')
        .addStringOption(option =>
            option.setName('map')
                .setDescription('Beatmap link or numeric ID')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('mods')
                .setDescription('Optional mod string, e.g., HDHR or +DT')
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('valo')
        .setDescription('Show Valorant profile stats for the configured player.'),
    new SlashCommandBuilder()
        .setName('valorecent')
        .setDescription('Show the most recent Valorant match for the configured player.'),
    new SlashCommandBuilder()
        .setName("safebooru")
        .setDescription("Get a random SFW image (general/sensitive) from booru with optional tags.")
        .addStringOption(o =>
            o.setName("tags")
             .setDescription("Optional tags, separated by spaces")
             .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName("booru")
        .setDescription("Get a random image from booru (NSFW allowed, NSFW channels only).")
        .addStringOption(o =>
            o.setName("tags")
             .setDescription("Optional tags, separated by spaces")
             .setRequired(false)
        ),
].map(cmd => cmd.toJSON());

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID || !process.env.GUILD_ID) {
    console.warn("Missing one or more required environment variables: DISCORD_TOKEN, CLIENT_ID, GUILD_ID. Skipping slash command registration.");
} else {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

    try {
        await rest.put(
            Routes.applicationGuildCommands(
                process.env.CLIENT_ID,
                process.env.GUILD_ID
            ),
            { body: commands }
        );
        console.log("Slash commands registered.");
    } catch (err) {
        console.error("Failed to register slash commands:", err);
    }
}

// --------------------------------------------
//          INTERACTION HANDLER
// --------------------------------------------

client.on('interactionCreate', async interaction => {
    // Handle button interactions
    if (interaction.isButton()) {
        const id = interaction.customId;
        if (id.startsWith('queue:')) {
            const parts = id.split(':');
            const guildId = parts[1];
            const targetPage = parseInt(parts[2], 10);
            
            if (interaction.guildId !== guildId) {
                return interaction.reply({ content: 'This queue is for a different server.', flags: MessageFlags.Ephemeral });
            }
            
            const queue = playerManager.queues?.get(guildId);
            if (!queue || !queue.songs.length) {
                return interaction.reply({ content: 'The queue is now empty.', flags: MessageFlags.Ephemeral });
            }
            
            await interaction.deferUpdate();
            
            const itemsPerPage = 20;
            const totalPages = Math.ceil(queue.songs.length / itemsPerPage);
            const currentPage = Math.max(0, Math.min(targetPage, totalPages - 1));
            
            // Build page
            const start = currentPage * itemsPerPage;
            const end = Math.min(start + itemsPerPage, queue.songs.length);
            const lines = [];
            
            for (let i = start; i < end; i++) {
                const title = queue.songs[i].title.length > 60 
                    ? queue.songs[i].title.substring(0, 57) + '...' 
                    : queue.songs[i].title;
                const line = i === 0 
                    ? `**▶️ Now:** ${title}` 
                    : `**${i}.** ${title}`;
                lines.push(line);
            }
            
            const embed = new EmbedBuilder()
                .setColor(0xffc6e6)
                .setTitle('🎀 Queue')
                .setDescription(lines.join('\n'))
                .setFooter({ text: `Page ${currentPage + 1}/${totalPages} • ${queue.songs.length} song${queue.songs.length > 1 ? 's' : ''} total` });
            
            const current = queue.songs[0];
            if (current?.thumbnail) {
                embed.setThumbnail(current.thumbnail);
            }
            
            // Update navigation buttons
            const row = new ActionRowBuilder();
            if (totalPages > 1) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`queue:${guildId}:${currentPage - 1}`)
                        .setLabel('◀')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(currentPage === 0),
                    new ButtonBuilder()
                        .setCustomId(`queue:${guildId}:${currentPage + 1}`)
                        .setLabel('▶')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(currentPage === totalPages - 1)
                );
            }
            
            await interaction.editReply({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
            return;
        }
        
        if (id.startsWith('playsong:')) {
            const parts = id.split(':');
            const userId = parts[1];
            const resultIndex = parseInt(parts[2], 10);
            
            if (interaction.user.id !== userId) {
                return interaction.reply({ content: 'Only the person who searched can select a song.', flags: MessageFlags.Ephemeral });
            }
            
            const vc = interaction.member.voice.channel;
            if (!vc) return interaction.reply({ content: 'Join a voice channel first…', flags: MessageFlags.Ephemeral });
            
            await interaction.deferUpdate();
            
            try {
                const message = interaction.message;
                const embed = message.embeds[0];
                if (!embed || !embed.fields) {
                    return interaction.followUp({ content: 'Could not find search results.', flags: MessageFlags.Ephemeral });
                }
                
                const field = embed.fields[resultIndex];
                if (!field) {
                    return interaction.followUp({ content: 'Invalid selection.', flags: MessageFlags.Ephemeral });
                }
                
                // Extract URL from field description (it's in the format "Artist • Duration\n[Watch](URL)")
                const urlMatch = field.value.match(/\[Watch\]\((https?:\/\/[^\)]+)\)/);
                if (!urlMatch) {
                    return interaction.followUp({ content: 'Could not find video URL.', flags: MessageFlags.Ephemeral });
                }
                
                const videoUrl = urlMatch[1];
                const queue = playerManager.get(interaction.guildId, interaction.channel);
                await queue.connect(vc);
                
                const beforeState = queue.player.state.status;
                const added = await queue.add(videoUrl, interaction.member);
                const position = queue.songs.findIndex(s => s.url === added.url);
                const isNow = position === 0 && (beforeState === AudioPlayerStatus.Idle);
                
                const responseEmbed = new EmbedBuilder()
                    .setColor(0xffc6e6)
                    .setTitle(isNow ? '🎶 Now Playing' : '➕ Added to Queue')
                    .setDescription(`**${added.title}**`)
                    .addFields(
                        { name: 'Artist', value: added.artist || 'Unknown', inline: true },
                        { name: 'Duration', value: formatDuration(added.duration) || 'Unknown', inline: true },
                        { name: 'Position', value: isNow ? 'Now' : `#${position}`, inline: true },
                    )
                    .setFooter({ text: `Requested by ${interaction.member.displayName || interaction.member.user?.username}` });
                
                if (added.thumbnail) responseEmbed.setThumbnail(added.thumbnail);
                
                await interaction.editReply({ embeds: [responseEmbed], components: [] });
            } catch (e) {
                await interaction.followUp({ content: `Failed to add song: ${e.message}`, flags: MessageFlags.Ephemeral });
            }
            return;
        }
        
        if (id.startsWith('dl:')) {
            const key = id.slice(3);
            const originalUrl = downloadRequests.get(key);
            if (!originalUrl) return interaction.reply({ content: 'Download request expired.' });
            await interaction.deferReply();
            try {
                const result = await tryDownloadWithYtDlp(originalUrl, MAX_ATTACH_BYTES);
                if (result.type === 'file') {
                    try {
                        await interaction.editReply({ content: `Downloaded ${result.name}\n➡ On PC: click the file, then use the Download/save option.\n➡ On phone: tap the file, then long‑press and Save/Download.`, files: [{ attachment: result.path, name: result.name }] });
                    } catch (e) {
                        if (result.directUrl) {
                            await interaction.editReply({ content: `Too large to attach. Direct link: ${result.directUrl}` });
                        } else {
                            await interaction.editReply({ content: `Too large to attach.` });
                        }
                    } finally {
                        try { await fs.unlink(result.path); } catch {}
                    }
                } else {
                    await interaction.editReply('Could not download this media.');
                }
            } catch (e) {
                await interaction.editReply(`Failed: ${e.message || e}`);
            }
            return;
        }

        if (id.startsWith('osutop:')) {
            const parts = id.split(':');
            const sessionId = parts[1];
            const rawTarget = Number(parts[2]);
            const targetPage = Number.isFinite(rawTarget) ? rawTarget : 0;

            const session = osuTopSessions.get(sessionId);
            if (!session || session.expiresAt < Date.now()) {
                osuTopSessions.delete(sessionId);
                return interaction.reply({ content: 'That session expired. Run /osutop again.', flags: MessageFlags.Ephemeral });
            }

            if (interaction.user.id !== session.userId) {
                return interaction.reply({ content: 'Only the command user can page through this list.', flags: MessageFlags.Ephemeral });
            }

            try {
                await ensureOsuTopDataForPage(session, Math.max(0, targetPage));
            } catch (err) {
                console.error('[osutop button] pagination fetch failed', err);
                return interaction.reply({ content: 'Failed to load more plays. Please try running /osutop again.', flags: MessageFlags.Ephemeral });
            }

            const { embed, components, page } = buildOsuTopPage(session, Math.max(0, targetPage));
            session.expiresAt = Date.now() + OSU_TOP_SESSION_TTL;
            session.lastPage = page;

            try {
                await interaction.update({ embeds: [embed], components });
            } catch (err) {
                console.error('[osutop button] failed', err);
                return interaction.reply({ content: 'Unable to update that embed. Try running /osutop again.', flags: MessageFlags.Ephemeral });
            }
            return;
        }
    }

    // From here on, only handle slash commands
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'download') {
        const url = interaction.options.getString('url');
        await interaction.deferReply();
        try {
                const result = await tryDownloadWithYtDlp(url, MAX_ATTACH_BYTES);
                            if (result.type === 'file') {
                                try {
                                    await interaction.editReply({ content: `Downloaded ${result.name}` , files: [{ attachment: result.path, name: result.name }] });
                                } catch (e) {
                                    // Likely too large to upload. Fallback to direct link if available.
                                    if (result.directUrl) {
                                        await interaction.editReply({ content: `File too large to attach. Direct link: ${result.directUrl}` });
                                    } else {
                                        await interaction.editReply({ content: `File too large to attach. Try this: ${fixSocialUrl(url) || url}` });
                                    }
                                } finally {
                                    // cleanup temp file
                                    try { await fs.unlink(result.path); } catch {}
                                }
                await interaction.editReply({ content: `File too large to attach. Direct link: ${result.url}` });
            } else {
                // fallback: try embed-fix link
                const fx = fixSocialUrl(url);
                await interaction.editReply({ content: fx ? `Couldn't download. Try this fixed link instead:\n${fx}` : `Couldn't download this URL.` });
            }
        } catch (e) {
            await interaction.editReply(`Download failed: ${e.message || e}`);
        }
    }

    // ------------------------
    // /help
    // ------------------------
    if (commandName === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor(0xffc6e6)
            .setTitle('Available Commands')
            .setDescription('Here are the main commands you can use:')
            .addFields(
                { name: '/play <query>', value: 'Play a song from YouTube or Spotify in your current voice channel.', inline: false },
                { name: '/queue', value: 'Show the current song queue.', inline: false },
                { name: '/remove <index>', value: 'Remove a song from the queue by its position.', inline: false },
                { name: '/shuffle', value: 'Shuffle the current queue.', inline: false },
                { name: '/skip', value: 'Skip the current song.', inline: false },
                { name: '/stop', value: 'Stop playback and clear the queue.', inline: false },
                { name: '/pause', value: 'Pause the current song.', inline: false },
                { name: '/resume', value: 'Resume the paused song.', inline: false },
                { name: '/nowplaying', value: 'Show details about the currently playing song.', inline: false },
                { name: '/download <url>', value: 'Download media from a social link or get a direct link.', inline: false }
            );

        return interaction.reply({ embeds: [helpEmbed], flags: MessageFlags.Ephemeral });
    }

    // ------------------------
    // /safebooru and /booru
    // ------------------------
    if (commandName === 'safebooru' || commandName === 'booru') {
        const isSafe = commandName === 'safebooru';
        // For /booru, require NSFW channel
        if (!isSafe && !interaction.channel?.nsfw) {
            return interaction.reply({ content: 'This command can only be used in NSFW channels.', flags: MessageFlags.Ephemeral });
        }

        const tagsInput = interaction.options.getString('tags') || '';
        const tags = tagsInput.trim();

        await interaction.deferReply();
        try {
            const post = await fetchRandomDanbooruPost(tags, { safeOnly: isSafe });
            if (!post) {
                const msg = isSafe
                    ? 'No SFW results found for that query.'
                    : 'No results found for that query.';
                return interaction.editReply(msg);
            }

            const imageUrl = post.large_file_url || post.file_url;
            if (!imageUrl) {
                return interaction.editReply('Found a post but it has no viewable image. Try again.');
            }

            // Get the original full-resolution image URL
            const originalImageUrl = post.file_url;
            const ratingMap = { g: 'General', s: 'Sensitive', q: 'Questionable', e: 'Explicit' };
            const ratingLabel = ratingMap[post.rating] || post.rating || 'Unknown';
            const postUrl = `https://danbooru.donmai.us/posts/${post.id}`;

            const booruEmbed = new EmbedBuilder()
                .setColor(isSafe ? 0x88ffb7 : 0xff88c2)
                .setTitle(`Random ${isSafe ? 'SFW ' : ''}Booru Image`)
                .setURL(postUrl)
                .setImage(imageUrl)
                .addFields(
                    { name: 'Rating', value: ratingLabel, inline: true },
                    { name: 'ID', value: String(post.id), inline: true }
                );

            if (post.tag_string_general) {
                const tagList = post.tag_string_general.split(' ').slice(0, 10).join(', ');
                if (tagList) {
                    booruEmbed.addFields({ name: 'Tags', value: tagList });
                }
            }

            // Add original image link
            if (originalImageUrl) {
                booruEmbed.addFields({ 
                    name: 'Links', 
                    value: `[Original Image](${originalImageUrl}) • [Danbooru Post](${postUrl})`,
                    inline: false 
                });
            }

            return interaction.editReply({ embeds: [booruEmbed] });
        } catch (e) {
            console.error('[booru] fetch failed', e);
            return interaction.editReply('Failed to fetch image from booru. Try again later.');
        }
    }

  if (commandName === 'playsong') {
    const query = interaction.options.getString('query');
    if (/soundcloud\.com/i.test(query)) return interaction.reply('SoundCloud disabled.');
    const vc = interaction.member.voice.channel;
    if (!vc) return interaction.reply('Join a voice channel first…');
    
    await interaction.deferReply();
    
    try {
        // Search for videos using play-dl
        const playdl = await import('play-dl');
        const searchResults = await playdl.search(query, { limit: 3, source: { youtube: 'video' } });
        
        if (!searchResults || searchResults.length === 0) {
            return interaction.editReply('No results found for that search.');
        }
        
        // Build embed with top 3 results
        const embed = new EmbedBuilder()
            .setColor(0xffc6e6)
            .setTitle('🔍 Search Results')
            .setDescription(`Found ${searchResults.length} result(s) for: **${query}**\n\nClick a button below to play:`)
            .setFooter({ text: `Requested by ${interaction.member.displayName || interaction.member.user?.username}` });
        
        // Add fields for each result
        searchResults.forEach((result, index) => {
            const duration = result.durationInSec ? formatDuration(result.durationInSec) : 'Live';
            const artist = result.channel?.name || 'Unknown';
            embed.addFields({
                name: `${index + 1}. ${result.title}`,
                value: `${artist} • ${duration}\n[Watch](${result.url})`,
                inline: false
            });
        });
        
        // Use first result's thumbnail
        if (searchResults[0]?.thumbnails?.[0]?.url) {
            embed.setThumbnail(searchResults[0].thumbnails[0].url);
        }
        
        // Create buttons for selection
        const row = new ActionRowBuilder();
        searchResults.forEach((result, index) => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`playsong:${interaction.user.id}:${index}`)
                    .setLabel(`${index + 1}`)
                    .setStyle(index === 0 ? ButtonStyle.Success : ButtonStyle.Primary)
                    .setEmoji(index === 0 ? '▶️' : '🎵')
            );
        });
        
        await interaction.editReply({ embeds: [embed], components: [row] });
    } catch (e) {
        console.error('[playsong] search failed', e);
        await interaction.editReply(`Search failed: ${e.message || 'Unknown error'}`);
    }
  }

  if (commandName === 'play') {
    const query = interaction.options.getString('query');
    if (/soundcloud\.com/i.test(query)) return interaction.reply('SoundCloud disabled.');
    const vc = interaction.member.voice.channel;
    if (!vc) return interaction.reply('Join a voice channel first…');
    const me = interaction.guild?.members?.me;
    const perms = vc.permissionsFor(me ?? client.user.id);
    if (!perms?.has(PermissionsBitField.Flags.Connect)) return interaction.reply('Need Connect permission.');
    if (!perms?.has(PermissionsBitField.Flags.Speak)) return interaction.reply('Need Speak permission.');
    await interaction.deferReply();
    const queue = playerManager.get(interaction.guildId, interaction.channel);
    await queue.connect(vc);
        try {
            const beforeState = queue.player.state.status;
            const addition = await queue.add(query, interaction.member);
            if (addition?.type === 'playlist') {
                const playlistEmbed = new EmbedBuilder()
                    .setColor(0xffc6e6)
                    .setTitle('📚 Playlist Queued')
                    .setDescription(`Added **${addition.trackCount}** tracks from **${addition.title}**`)
                    .setFooter({ text: `Requested by ${interaction.member.displayName || interaction.member.user?.username}` });
                if (addition.firstTrack) {
                    playlistEmbed.addFields({
                        name: 'First Track',
                        value: `**${addition.firstTrack.title}**\n${addition.firstTrack.artist || 'Unknown'} • ${formatDuration(addition.firstTrack.duration) || '?'}`,
                        inline: false,
                    });
                    if (addition.firstTrack.thumbnail) playlistEmbed.setThumbnail(addition.firstTrack.thumbnail);
                }
                await interaction.editReply({ embeds: [playlistEmbed] });
                return;
            }

            const added = addition?.track ?? addition;
            const position = queue.songs.findIndex(s => s.url === added.url);
            const isNow = position === 0 && (beforeState === AudioPlayerStatus.Idle);
            const embed = new EmbedBuilder()
                .setColor(0xffc6e6)
                .setTitle(isNow ? '🎶 Now Playing' : '➕ Added to Queue')
                .setDescription(`**${added.title}**`)
                .addFields(
                    { name: 'Artist', value: added.artist || 'Unknown', inline: true },
                    { name: 'Duration', value: formatDuration(added.duration) || 'Unknown', inline: true },
                    { name: 'Position', value: isNow ? 'Now' : `#${position}`, inline: true },
                )
                .setFooter({ text: `Requested by ${interaction.member.displayName || interaction.member.user?.username}` });
            if (isNow && added.duration) {
                embed.addFields({ name: 'Progress', value: buildProgressBar(0, added.duration) || 'Starting…' });
            }
            const upcoming = queue.songs[1];
            if (isNow && upcoming) {
                embed.addFields({ name: 'Up Next', value: `**${upcoming.title}**\n${upcoming.artist || 'Unknown'} • ${formatDuration(upcoming.duration) || '?'}`, inline: false });
            }
            if (added.thumbnail) embed.setThumbnail(added.thumbnail);
            await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      await interaction.editReply(`Search/play failed: ${e.message}`);
    }
  }

    if (commandName === 'queue') {
        const queue = playerManager.queues?.get(interaction.guildId);
        if (!queue || !queue.songs.length) return interaction.reply('The queue is empty…');
        
        const itemsPerPage = 20;
        const totalPages = Math.ceil(queue.songs.length / itemsPerPage);
        const currentPage = 0; // Start at page 0
        
        // Build page
        const buildQueuePage = (page) => {
            const start = page * itemsPerPage;
            const end = Math.min(start + itemsPerPage, queue.songs.length);
            const lines = [];
            
            for (let i = start; i < end; i++) {
                const title = queue.songs[i].title.length > 60 
                    ? queue.songs[i].title.substring(0, 57) + '...' 
                    : queue.songs[i].title;
                const line = i === 0 
                    ? `**▶️ Now:** ${title}` 
                    : `**${i}.** ${title}`;
                lines.push(line);
            }
            
            const embed = new EmbedBuilder()
                .setColor(0xffc6e6)
                .setTitle('🎀 Queue')
                .setDescription(lines.join('\n'))
                .setFooter({ text: `Page ${page + 1}/${totalPages} • ${queue.songs.length} song${queue.songs.length > 1 ? 's' : ''} total` });
            
            const current = queue.songs[0];
            if (current?.thumbnail) {
                embed.setThumbnail(current.thumbnail);
            }
            
            return embed;
        };
        
        const embed = buildQueuePage(currentPage);
        
        // Create navigation buttons
        const row = new ActionRowBuilder();
        if (totalPages > 1) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`queue:${interaction.guildId}:${currentPage - 1}`)
                    .setLabel('◀')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(currentPage === 0),
                new ButtonBuilder()
                    .setCustomId(`queue:${interaction.guildId}:${currentPage + 1}`)
                    .setLabel('▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(currentPage === totalPages - 1)
            );
        }
        
        return interaction.reply({ 
            embeds: [embed], 
            components: totalPages > 1 ? [row] : [] 
        });
    }

    if (commandName === 'remove') {
        const queue = playerManager.queues?.get(interaction.guildId);
        if (!queue || !queue.songs.length) return interaction.reply('The queue is empty…');
        const index = interaction.options.getInteger('index');
        const removed = queue.remove(index);
        if (!removed) return interaction.reply('Invalid queue number…');
        return interaction.reply(`Removed **${removed.title}** from queue.`);
    }

    if (commandName === 'shuffle') {
        const queue = playerManager.queues?.get(interaction.guildId);
        if (!queue || !queue.songs.length) return interaction.reply('The queue is empty…');
        queue.shuffle();
        
        // Show shuffled queue with pagination
        const itemsPerPage = 20;
        const totalPages = Math.ceil(queue.songs.length / itemsPerPage);
        const currentPage = 0; // Start at page 0
        
        // Build page
        const buildShufflePage = (page) => {
            const start = page * itemsPerPage;
            const end = Math.min(start + itemsPerPage, queue.songs.length);
            const lines = [];
            
            for (let i = start; i < end; i++) {
                const title = queue.songs[i].title.length > 60 
                    ? queue.songs[i].title.substring(0, 57) + '...' 
                    : queue.songs[i].title;
                const line = i === 0 
                    ? `**▶️ Now:** ${title}` 
                    : `**${i}.** ${title}`;
                lines.push(line);
            }
            
            const embed = new EmbedBuilder()
                .setColor(0xffc6e6)
                .setTitle('🔀 Queue Shuffled')
                .setDescription(lines.join('\n'))
                .setFooter({ text: `Page ${page + 1}/${totalPages} • ${queue.songs.length} song${queue.songs.length > 1 ? 's' : ''} total` });
            
            const current = queue.songs[0];
            if (current?.thumbnail) {
                embed.setThumbnail(current.thumbnail);
            }
            
            return embed;
        };
        
        const embed = buildShufflePage(currentPage);
        
        // Create navigation buttons
        const row = new ActionRowBuilder();
        if (totalPages > 1) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`queue:${interaction.guildId}:${currentPage - 1}`)
                    .setLabel('◀')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(currentPage === 0),
                new ButtonBuilder()
                    .setCustomId(`queue:${interaction.guildId}:${currentPage + 1}`)
                    .setLabel('▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(currentPage === totalPages - 1)
            );
        }
        
        return interaction.reply({ 
            embeds: [embed], 
            components: totalPages > 1 ? [row] : [] 
        });
    }

  if (commandName === 'volume') {
    return interaction.reply('Volume control not implemented yet.');
  }

    if (commandName === 'skip') {
        const queue = playerManager.queues?.get(interaction.guildId);
        if (!queue || !queue.songs.length) return interaction.reply('Nothing is playing…');
        if (queue.skip()) return interaction.reply('Skipped ♪');
        return interaction.reply('Nothing to skip.');
    }

    if (commandName === 'stop') {
        const queue = playerManager.queues?.get(interaction.guildId);
        if (!queue || !queue.songs.length) return interaction.reply('Nothing is playing…');
        queue.stop();
        return interaction.reply('Stopped playback and cleared queue.');
    }

    if (commandName === 'pause') {
        const queue = playerManager.queues?.get(interaction.guildId);
        if (!queue || !queue.songs.length) return interaction.reply('Nothing is playing…');
        if (queue.pause()) return interaction.reply('Paused.');
        return interaction.reply("Couldn't pause.");
    }

    if (commandName === 'resume') {
        const queue = playerManager.queues?.get(interaction.guildId);
        if (!queue || !queue.songs.length) return interaction.reply('Nothing is playing…');
        if (queue.resume()) return interaction.reply('Resumed.');
        return interaction.reply("Couldn't resume.");
    }

        if (commandName === 'nowplaying') {
                const queue = playerManager.queues?.get(interaction.guildId);
                if (!queue || !queue.songs.length) return interaction.reply('Nothing is playing…');
                const current = queue.songs[0];
        if (!current) return interaction.reply('Nothing is playing…');
        const status = queue.player.state.status;
            const elapsed = queue.getElapsedSeconds();
            const progress = current.duration ? buildProgressBar(elapsed, current.duration) : null;
            const upcoming = queue.songs[1];
            const embed = new EmbedBuilder()
                .setColor(0xffc6e6)
                .setTitle('🎶 Now Playing')
                .setDescription(`**${current.title}**`)
                .addFields(
                    { name: 'Artist', value: current.artist || 'Unknown', inline: true },
                    { name: 'Duration', value: formatDuration(current.duration) || 'Unknown', inline: true },
                    { name: 'Status', value: status, inline: true }
                )
                .setFooter({ text: `Requested by ${current.requestedBy}` });
            if (progress) embed.addFields({ name: 'Progress', value: progress });
            if (upcoming) embed.addFields({ name: 'Up Next', value: `**${upcoming.title}**\n${upcoming.artist || 'Unknown'} • ${formatDuration(upcoming.duration) || '?'}` });
            if (current.thumbnail) embed.setThumbnail(current.thumbnail);
            return interaction.reply({ embeds: [embed] });
    }
    
    if (commandName === 'profile') {
        const user = interaction.user;
        const member = interaction.member;

        const createdAt = user.createdAt;
        const joinedAt = member?.joinedAt;

        const embed = new EmbedBuilder()
            .setColor(0xffc6e6)
            .setTitle(`Profile: ${user.tag}`)
            .setThumbnail(user.displayAvatarURL({ size: 1024 }))
            .addFields(
                { name: 'Username', value: user.tag, inline: true },
                { name: 'User ID', value: user.id, inline: true },
                { name: 'Bot?', value: user.bot ? 'Yes' : 'No', inline: true },
                { name: 'Account Created', value: `<t:${Math.floor(createdAt.getTime() / 1000)}:F>`, inline: false },
            );

        if (joinedAt) {
            embed.addFields({ name: 'Joined This Server', value: `<t:${Math.floor(joinedAt.getTime() / 1000)}:F>`, inline: false });
        }

        if (member?.roles?.cache?.size) {
            const roles = member.roles.cache
                .filter(r => r.name !== '@everyone')
                .map(r => `<@&${r.id}>`)
                .slice(0, 10);
            if (roles.length) {
                embed.addFields({ name: 'Top Roles', value: roles.join(', '), inline: false });
            }
        }

        return interaction.reply({ embeds: [embed] });
    }
    
    if (commandName === 'osuprofile') {
        if (!OSU_USERNAME) {
            return interaction.reply({ content: 'OSU_USERNAME is not configured in the bot.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply();
        try {
            const user = await fetchOsuUser('osu');
            const stats = user.statistics || {};

            const embed = new EmbedBuilder()
                .setColor(0xffaacc)
                .setTitle(`osu! Profile — ${user.username}`)
                .setURL(`https://osu.ppy.sh/users/${user.id}`)
                .setThumbnail(user.avatar_url)
                .addFields(
                    { name: 'PP', value: stats.pp ? stats.pp.toFixed(2) : 'Unknown', inline: true },
                    { name: 'Global Rank', value: stats.global_rank ? `#${stats.global_rank.toLocaleString()}` : 'Unranked', inline: true },
                    { name: 'Country Rank', value: stats.country_rank ? `#${stats.country_rank.toLocaleString()} (${user.country_code})` : 'N/A', inline: true },
                    { name: 'Accuracy', value: stats.hit_accuracy ? `${stats.hit_accuracy.toFixed(2)}%` : 'Unknown', inline: true },
                    { name: 'Play Count', value: stats.play_count != null ? stats.play_count.toLocaleString() : 'Unknown', inline: true },
                    { name: 'Level', value: stats.level?.current != null ? `${stats.level.current}.${Math.floor((stats.level.progress || 0))}` : 'Unknown', inline: true },
                );

            if (stats.grade_counts) {
                embed.addFields({
                    name: 'Grades',
                    value: `SS: ${stats.grade_counts.ssh + stats.grade_counts.ss || 0} | S: ${stats.grade_counts.sh + stats.grade_counts.s || 0} | A: ${stats.grade_counts.a || 0}`,
                    inline: false,
                });
            }

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            console.error('[osuprofile] failed', e);
            return interaction.editReply('Failed to fetch osu! profile. Check OSU_CLIENT_ID / SECRET and OSU_USERNAME.');
        }
    }

if (commandName === 'osurecent') {
    if (!OSU_USERNAME) {
        return interaction.reply({
            content: 'OSU_USERNAME is not configured in the bot.',
            flags: MessageFlags.Ephemeral
        });
    }
    await interaction.deferReply();
    try {
        const scores = await fetchOsuRecent('osu');
        if (!Array.isArray(scores) || !scores.length) {
            return interaction.editReply('No recent plays found.');
        }

        const score = scores[0];
        const embed = await buildOsuRecentEmbedFromScore(score, { title: 'Most Recent osu! Play' });
        return interaction.editReply({ embeds: [embed] });
    } catch (e) {
        console.error('[osurecent] failed', e);
        return interaction.editReply('Failed to fetch recent osu! play. Check OSU_CLIENT_ID / SECRET and OSU_USERNAME.');
    }
}

if (commandName === 'osutop') {
    if (!OSU_USERNAME) {
        return interaction.reply({
            content: 'OSU_USERNAME is not configured in the bot.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const limitOption = interaction.options.getInteger('limit');
    const limit = Math.min(Math.max(limitOption ?? 10, 1), 25);

    await interaction.deferReply();
    try {
        const scores = await fetchOsuTopScores(limit, 'osu', 0);
        if (!Array.isArray(scores) || !scores.length) {
            return interaction.editReply('No top plays found for the configured user.');
        }

        const topUser = scores[0]?.user || null;
        const displayName = topUser?.username || OSU_USERNAME;
        const avatarUrl = topUser?.avatar_url || null;

        let heroBeatmap = scores[0]?.beatmap || null;
        let heroBeatmapset = heroBeatmap?.beatmapset || scores[0]?.beatmapset || null;
        const heroBeatmapId = heroBeatmap?.id;

        if (!heroBeatmapset && heroBeatmapId) {
            try {
                const heroFetch = await fetchOsuBeatmap(heroBeatmapId);
                heroBeatmapset = heroFetch?.beatmapset || heroBeatmapset;
                heroBeatmap = heroFetch || heroBeatmap;
            } catch (err) {
                console.warn('[osutop] hero beatmap fetch failed', err);
            }
        }

        const coverBase = heroBeatmapset?.id
            ? `https://assets.ppy.sh/beatmaps/${heroBeatmapset.id}/covers`
            : null;
        const coverImage = heroBeatmapset?.covers?.['cover@2x']
            || heroBeatmapset?.covers?.cover
            || (coverBase ? `${coverBase}/cover.jpg` : null);
        const thumbnailImage = avatarUrl
            || heroBeatmapset?.covers?.list
            || (coverBase ? `${coverBase}/list.jpg` : null);

        const perPage = 5;
        const sessionId = crypto.randomUUID();
        const session = {
            id: sessionId,
            userId: interaction.user.id,
            scores,
            perPage,
            displayName,
            thumbnailImage: thumbnailImage || avatarUrl || null,
            coverImage: coverImage || null,
            expiresAt: Date.now() + OSU_TOP_SESSION_TTL,
            mode: 'osu',
            chunkSize: limit,
            nextOffset: scores.length,
            reachedEnd: scores.length < limit,
            loadingPromise: null,
            lastPage: 0,
        };

        osuTopSessions.set(sessionId, session);
        setTimeout(() => {
            const saved = osuTopSessions.get(sessionId);
            if (saved && saved.id === sessionId && saved.expiresAt <= Date.now()) {
                osuTopSessions.delete(sessionId);
            }
        }, OSU_TOP_SESSION_TTL + 1000).unref?.();

        const { embed, components } = buildOsuTopPage(session, 0);
        return interaction.editReply({ embeds: [embed], components });
    } catch (err) {
        console.error('[osutop] failed', err);
        return interaction.editReply('Failed to fetch top plays. Check OSU credentials and try again.');
    }
}

if (commandName === 'osumap') {
    const mapArg = interaction.options.getString('map', true)?.trim();
    const modsArg = interaction.options.getString('mods')?.trim();
    if (!mapArg) {
        return interaction.reply({ content: 'Please provide a beatmap link or ID.', flags: MessageFlags.Ephemeral });
    }

    const { beatmapId, beatmapsetId } = extractBeatmapIds(mapArg);
    if (!beatmapId && !beatmapsetId) {
        return interaction.reply({ content: 'Could not figure out that beatmap link. Please paste the full osu! URL.', flags: MessageFlags.Ephemeral });
    }

    const mods = parseModsString(modsArg);
    await interaction.deferReply();

    try {
        let beatmap = null;
        let beatmapset = null;
        let resolvedBeatmapId = beatmapId || null;
        let resolvedBeatmapsetId = beatmapsetId || null;

        if (resolvedBeatmapId) {
            beatmap = await fetchOsuBeatmap(resolvedBeatmapId);
            beatmapset = beatmap?.beatmapset || null;
            resolvedBeatmapsetId = beatmapset?.id || beatmap?.beatmapset_id || resolvedBeatmapsetId;
        }

        if (!beatmapset && (resolvedBeatmapsetId || (!resolvedBeatmapId && beatmapsetId))) {
            const fetchedSet = await fetchOsuBeatmapset(resolvedBeatmapsetId || beatmapsetId);
            beatmapset = fetchedSet;
            resolvedBeatmapsetId = fetchedSet?.id || resolvedBeatmapsetId;
            if (!beatmap && Array.isArray(fetchedSet?.beatmaps) && fetchedSet.beatmaps.length) {
                beatmap = fetchedSet.beatmaps.reduce((best, cur) => {
                    if (!best) return cur;
                    return (cur.difficulty_rating || 0) > (best.difficulty_rating || 0) ? cur : best;
                }, fetchedSet.beatmaps[0]);
                resolvedBeatmapId = beatmap?.id || resolvedBeatmapId;
            }
        }

        if (!beatmap && resolvedBeatmapId) {
            beatmap = await fetchOsuBeatmap(resolvedBeatmapId);
            beatmapset = beatmap?.beatmapset || beatmapset;
            resolvedBeatmapsetId = beatmapset?.id || beatmap?.beatmapset_id || resolvedBeatmapsetId;
        }

        if (!beatmap) {
            return interaction.editReply('Could not load that beatmap. Make sure the link is correct.');
        }

        const coverBase = resolvedBeatmapsetId ? `https://assets.ppy.sh/beatmaps/${resolvedBeatmapsetId}/covers` : null;
        const coverImage = beatmapset?.covers?.['cover@2x']
            || beatmapset?.covers?.cover
            || (coverBase ? `${coverBase}/cover.jpg` : null);
        const thumbnailImage = beatmapset?.covers?.list
            || beatmapset?.covers?.card
            || (coverBase ? `${coverBase}/list.jpg` : null);

        const mode = beatmap.mode || 'osu';
        let attributes = null;
        if (resolvedBeatmapId) {
            try {
                attributes = await fetchOsuBeatmapAttributes(resolvedBeatmapId, mods, mode);
            } catch (err) {
                console.warn('[osumap] beatmap attributes fetch failed', err);
            }
        }

        const artist = beatmapset?.artist || beatmap?.beatmapset?.artist || 'Unknown artist';
        const title = beatmapset?.title || beatmap?.beatmapset?.title || 'Unknown title';
        const version = beatmap.version || 'Unknown difficulty';
        const mapper = beatmapset?.creator || beatmap?.creator || 'Unknown mapper';
        const bpm = beatmap.bpm ? `${beatmap.bpm.toFixed(2)} BPM` : 'Unknown BPM';
        const totalLength = beatmap.total_length ? formatDuration(beatmap.total_length) : 'Unknown';
        const hitLength = beatmap.hit_length ? formatDuration(beatmap.hit_length) : null;
        const starRating = attributes?.attributes?.star_rating ?? beatmap.difficulty_rating;
        const ar = attributes?.attributes?.approach_rate ?? beatmap.ar;
        const od = attributes?.attributes?.overall_difficulty ?? beatmap.accuracy;
        const cs = attributes?.attributes?.circle_size ?? beatmap.cs;
        const hp = attributes?.attributes?.drain ?? beatmap.drain;
        const maxCombo = attributes?.attributes?.max_combo ?? beatmap.max_combo;
        const estPp = attributes?.attributes?.pp ?? null;
        const circleCount = beatmap.count_circles || 0;
        const sliderCount = beatmap.count_sliders || 0;
        const spinnerCount = beatmap.count_spinners || 0;

        const modsDisplay = mods.length ? mods.join('') : 'No Mod';
        const mapUrl = resolvedBeatmapId ? `https://osu.ppy.sh/beatmaps/${resolvedBeatmapId}`
            : (resolvedBeatmapsetId ? `https://osu.ppy.sh/beatmapsets/${resolvedBeatmapsetId}` : undefined);

        const embed = new EmbedBuilder()
            .setColor(0xff88cc)
            .setTitle(`${artist} - ${title} [${version}]`)
            .setDescription(`Mode: **${mode}** • Mods: **${modsDisplay}**`)
            .addFields(
                { name: 'Mapper', value: mapper, inline: true },
                { name: 'Stars', value: starRating ? `${starRating.toFixed(2)}★` : 'Unknown', inline: true },
                { name: 'BPM', value: bpm, inline: true },
                { name: 'Length', value: hitLength ? `${hitLength} (drain)` : totalLength, inline: true },
                { name: 'Max Combo', value: maxCombo ? `${maxCombo.toLocaleString()}x` : 'Unknown', inline: true },
                { name: 'Estimated PP', value: estPp ? `${estPp.toFixed(2)}pp` : 'N/A', inline: true },
                { name: 'AR / OD / CS / HP', value: `${ar?.toFixed(1) ?? '?'}/${od?.toFixed(1) ?? '?'}/${cs?.toFixed(1) ?? '?'}/${hp?.toFixed(1) ?? '?'}`, inline: false },
                { name: 'Objects', value: `○ ${circleCount} | ▢ ${sliderCount} | ◎ ${spinnerCount}`, inline: false },
            );

        if (mapUrl) embed.setURL(mapUrl);
        if (thumbnailImage) embed.setThumbnail(thumbnailImage);
        if (coverImage) embed.setImage(coverImage);

        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('[osumap] failed', err);
        return interaction.editReply('Failed to load that map. Check the link and try again.');
    }
}

if (commandName === 'valo') {
    if (!VALORANT_NAME || !VALORANT_TAG) {
        return interaction.reply({ content: 'VALORANT_NAME and VALORANT_TAG must be set in the bot configuration.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
        const [accountData, mmrData, matchesData] = await Promise.all([
            fetchValorantAccount(),
            fetchValorantMMR().catch(err => {
                console.warn('[valo] mmr fetch failed', err);
                return null;
            }),
            fetchValorantRecentMatches(5).catch(err => {
                console.warn('[valo] matches fetch failed', err);
                return null;
            }),
        ]);

        const account = accountData?.data;
        if (!account) {
            return interaction.editReply('Could not load Valorant account data. Double-check the IGN and tag.');
        }

        const mmr = mmrData?.data || {};
        const matches = matchesData?.data || [];
        const summary = summarizeValorantMatches(matches);
        const totalShots = summary.headshots + summary.bodyshots + summary.legshots;
        const kd = summary.deaths ? summary.kills / summary.deaths : (summary.kills ? Infinity : null);
        const kda = summary.deaths ? (summary.kills + summary.assists) / summary.deaths : (summary.kills + summary.assists);
        const hsPercent = totalShots ? (summary.headshots / totalShots) * 100 : 0;
        const adr = summary.rounds ? summary.damage / summary.rounds : null;
        const avgAcs = summary.rounds ? summary.totalScore / summary.rounds : null;
        const wrPercent = summary.games ? (summary.wins / summary.games) * 100 : null;
        const losses = summary.games - summary.wins;
        const avgKills = formatAverage(summary.kills, summary.games);
        const avgDeaths = formatAverage(summary.deaths, summary.games);
        const avgAssists = formatAverage(summary.assists, summary.games);
        const avgDamage = summary.games ? formatAverage(summary.damage, summary.games, 0) : 'N/A';
        const topAgentsText = describeTopCounts(summary.agentCounts, 'agent');
        const topMapsText = describeTopCounts(summary.mapCounts, 'map');
        const topQueuesText = describeTopCounts(summary.queueCounts, 'mode');

        const unranked = !mmr.currenttierpatched || /unranked/i.test(mmr.currenttierpatched);
        const rankDisplay = mmr.currenttierpatched || 'Unranked';
        const rrDisplay = Number.isFinite(mmr.ranking_in_tier)
            ? `${mmr.ranking_in_tier} RR`
            : (unranked ? '— play competitive placements to earn RR' : '— RR unavailable');
        const eloDisplay = Number.isFinite(mmr.elo)
            ? `${mmr.elo}`
            : (unranked ? '— no MMR until ranked' : '— unavailable');
        const lastRrChange = Number.isFinite(mmr.mmr_change_to_last_game)
            ? `${mmr.mmr_change_to_last_game > 0 ? '+' : ''}${mmr.mmr_change_to_last_game}`
            : '— no tracked ranked games';
        const winrateDisplay = summary.games ? formatPerc(wrPercent ?? 0) : 'No matches yet';
        const kdDisplay = summary.games ? `${Number.isFinite(kd) ? kd.toFixed(2) : 'Perfect'} / ${Number.isFinite(kda) ? kda.toFixed(2) : 'Perfect'}` : 'No matches yet';
        const adrAcsDisplay = summary.rounds ? `${Number.isFinite(adr) ? adr.toFixed(0) : 'N/A'} / ${Number.isFinite(avgAcs) ? avgAcs.toFixed(0) : 'N/A'}` : 'No rounds yet';
        const headshotDisplay = summary.games ? formatPerc(hsPercent ?? 0) : 'No shots yet';
        const roundsDisplay = summary.rounds
            ? `${summary.rounds} total • ${summary.roundsWon}-${summary.roundsLost} rounds`
            : 'No rounds recorded yet';
        const recentAvgText = summary.games
            ? `K ${avgKills} • D ${avgDeaths} • A ${avgAssists} • Dmg ${avgDamage}`
            : 'Play some matches to populate this section.';

        const embed = new EmbedBuilder()
            .setColor(0xf04d8c)
            .setTitle(`Valorant Profile — ${account.name}#${account.tag}`)
            .setDescription(`Region: ${account.region?.toUpperCase() || VALORANT_REGION.toUpperCase()} • Level ${account.account_level ?? 'Unknown'}`)
            .addFields(
                { name: 'Rank', value: rankDisplay, inline: true },
                { name: 'Ranked Rating', value: rrDisplay, inline: true },
                { name: 'ELO', value: eloDisplay, inline: true },
                { name: 'Last RR Change', value: lastRrChange, inline: true },
                { name: 'Recent Record', value: summary.games ? `${summary.wins}-${losses} (${summary.games} matches)` : 'No recent matches', inline: true },
                { name: 'Recent Winrate', value: winrateDisplay, inline: true },
                { name: 'Recent KD / KDA', value: kdDisplay, inline: true },
                { name: 'Avg ADR / ACS', value: adrAcsDisplay, inline: true },
                { name: 'Headshot %', value: headshotDisplay, inline: true },
                { name: 'Rounds (recent)', value: roundsDisplay, inline: true },
                { name: 'Recent Averages', value: recentAvgText, inline: false },
                { name: 'Top Agents (recent)', value: summary.games ? topAgentsText : 'No matches yet.', inline: true },
                { name: 'Top Maps', value: summary.games ? topMapsText : 'No matches yet.', inline: true },
                { name: 'Queues Played', value: summary.games ? topQueuesText : 'No matches yet.', inline: true },
            );

        const profileThumb = normalizeImageUrl(account.card?.small);
        const profileBanner = normalizeImageUrl(account.card?.wide);
        if (profileThumb) embed.setThumbnail(profileThumb);
        if (profileBanner) embed.setImage(profileBanner);
        embed.setFooter({ text: `Tracked as ${account.name}#${account.tag} • via HenrikDev API` });

        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('[valo] failed', err);
        return interaction.editReply('Failed to load Valorant profile. Please try again in a moment.');
    }
}

if (commandName === 'valorecent') {
    if (!VALORANT_NAME || !VALORANT_TAG) {
        return interaction.reply({ content: 'VALORANT_NAME and VALORANT_TAG must be set in the bot configuration.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
        const matches = await fetchValorantRecentMatches(1);
        const match = matches?.data?.[0];
        if (!match) {
            return interaction.editReply('No recent Valorant matches found for the configured player.');
        }

        const player = findConfiguredValorantPlayer(match);
        if (!player) {
            return interaction.editReply('Could not locate the configured player in the latest match.');
        }

        const stats = player.stats || {};
        const kills = stats.kills ?? player.kills ?? 0;
        const deaths = stats.deaths ?? player.deaths ?? 0;
        const assists = stats.assists ?? player.assists ?? 0;
        const kd = deaths ? kills / deaths : (kills ? Infinity : 0);
        const kda = deaths ? (kills + assists) / deaths : (kills + assists);
        const shots = stats.shots || {};
        const totalShots = (shots.head ?? 0) + (shots.body ?? 0) + (shots.leg ?? 0);
        const hsPercent = totalShots ? (shots.head / totalShots) * 100 : null;
        const roundsPlayed = match.metadata?.rounds_played ?? 0;
        const damageMade = player.damage_made ?? 0;
        const adr = roundsPlayed ? damageMade / roundsPlayed : null;
        const acs = roundsPlayed ? (stats.score ?? 0) / roundsPlayed : null;
        const agent = player.character || 'Unknown Agent';
        const mapName = match.metadata?.map || 'Unknown Map';
        const mode = match.metadata?.mode || match.metadata?.queue || 'Unknown Mode';
        const startedAt = match.metadata?.game_start || match.metadata?.game_start_patched;
        const teamKey = (player.team || '').toLowerCase();
        const teams = match.teams || {};
        const teamStats = teams[teamKey];
        const opponentKey = teamKey === 'red' ? 'blue' : 'red';
        const opponentStats = teams[opponentKey];
        const finalScore = `${teamStats?.rounds_won ?? '?'} - ${opponentStats?.rounds_won ?? '?'}`;
        const resultText = teamStats?.has_won ? 'Victory' : 'Defeat';

        const embed = new EmbedBuilder()
            .setColor(teamStats?.has_won ? 0x57f287 : 0xed4245)
            .setTitle('Most Recent Valorant Match')
            .setDescription(`${mode} on ${mapName}\n${resultText} • Final Score ${finalScore}\nStarted ${formatDiscordTimestamp(startedAt)}`)
            .addFields(
                { name: 'Agent', value: agent, inline: true },
                { name: 'K / D / A', value: `${kills}/${deaths}/${assists}`, inline: true },
                { name: 'KD / KDA', value: `${Number.isFinite(kd) ? kd.toFixed(2) : 'Perfect'} / ${Number.isFinite(kda) ? kda.toFixed(2) : 'Perfect'}`, inline: true },
                { name: 'Headshot %', value: formatPerc(hsPercent), inline: true },
                { name: 'ADR / ACS', value: `${Number.isFinite(adr) ? adr.toFixed(0) : 'N/A'} / ${Number.isFinite(acs) ? acs.toFixed(0) : 'N/A'}`, inline: true },
                { name: 'Damage', value: `${damageMade.toLocaleString()} dealt • ${(player.damage_received ?? 0).toLocaleString()} taken`, inline: true },
                { name: 'Scoreboard', value: formatValorantScoreboardLines(match), inline: false },
            );

        const matchThumb = normalizeImageUrl(player.assets?.card?.small);
        const matchBanner = normalizeImageUrl(player.assets?.card?.wide);
        if (matchThumb) embed.setThumbnail(matchThumb);
        if (matchBanner) embed.setImage(matchBanner);
        embed.setFooter({ text: `${player.name}#${player.tag}` });

        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('[valorecent] failed', err);
        return interaction.editReply('Failed to load the latest Valorant match. Please try again shortly.');
    }
}
});



client.on('clientReady', () => {
    console.log(`🌸 ${client.user.tag} is ready — humming softly...`);
    if (!ENABLE_MESSAGE_CONTENT) {
        console.warn('MessageContent intent disabled — auto embed-fix requires it. Enable in Developer Portal and set ENABLE_MESSAGE_CONTENT=true in .env');
    }

    if (OSU_RECENT_CHANNEL_ID) {
        startOsuRecentWatcher().catch(err => {
            console.error('[osu recent watcher] failed to start', err);
        });
    } else {
        console.log('[osu recent watcher] OSU_RECENT_CHANNEL_ID not set — skipping auto recent announcements.');
    }

    applyBotPresence();
});

// Prefer DISCORD_TOKEN but accept BOT_TOKEN as a fallback for convenience.
const BOT_TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
if (!BOT_TOKEN || typeof BOT_TOKEN !== 'string') {
    console.error('Missing or invalid bot token. Set DISCORD_TOKEN (or BOT_TOKEN) in your .env.');
    process.exit(1);
}

client.login(BOT_TOKEN);

// --------------------------------------------
//                 HELPERS
// --------------------------------------------

function extractUrls(text) {
    if (!text) return [];
    // basic URL regex; good enough for common cases
    const re = /https?:\/\/[\w.-]+(?:\/[\w\-._~:/?#\[\]@!$&'()*+,;=%]*)?/gi;
    const matches = text.match(re) || [];
    // de-dup
    return Array.from(new Set(matches));
}

function fixSocialUrl(raw) {
    try {
        const u = new URL(raw);
        const host = u.hostname.toLowerCase();
        // X/Twitter
        if (host.endsWith('twitter.com') || host === 'x.com' || host.endsWith('.x.com') || host.startsWith('mobile.twitter.com')) {
            u.hostname = 'fxtwitter.com';
            return u.toString();
        }
        // Reddit (posts and v.redd.it videos)
        if (host.endsWith('reddit.com') || host === 'redd.it' || host === 'v.redd.it') {
            u.hostname = 'rxddit.com';
            return u.toString();
        }
        // Instagram
        if (host.endsWith('instagram.com') || host === 'www.instagram.com') {
            u.hostname = 'ddinstagram.com';
            return u.toString();
        }
        // TikTok
        if (host.endsWith('tiktok.com')) {
            u.hostname = 'vxtiktok.com';
            return u.toString();
        }
        // Facebook: use m.facebook.com for lighter page & OG tags accessibility
        if (host.endsWith('facebook.com')) {
            u.hostname = 'm.facebook.com';
            return u.toString();
        }
        return null;
    } catch {
        return null;
    }
}

async function tryDownloadWithYtDlp(url, limitBytes) {
    // Step 1: inspect formats via JSON
    let info;
    try {
        info = await youtubedl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificates: true,
            preferFreeFormats: true,
            referer: url
        });
    } catch (e) {
        // couldn't fetch metadata
        return { type: 'error', error: e };
    }

        const formats = Array.isArray(info.formats) ? info.formats : [];
        const bestAvStream = (() => {
            try {
                return formats
                    .filter(f => (!f.vcodec || f.vcodec !== 'none') && (!f.acodec || f.acodec !== 'none'))
                    .sort((a,b) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0))[0];
            } catch {
                return undefined;
            }
        })();
    // Prefer muxed formats with both audio+video
        const candidates = formats.filter(f => {
        const fs = f.filesize || f.filesize_approx;
        const hasAv = (!f.vcodec || f.vcodec !== 'none') && (!f.acodec || f.acodec !== 'none');
            const underLimit = !Number.isFinite(limitBytes) ? true : (fs && fs > 0 && fs <= limitBytes);
            return underLimit && hasAv;
    }).sort((a,b) => (a.filesize || a.filesize_approx || 0) - (b.filesize || b.filesize_approx || 0));

    if (candidates.length) {
        const best = candidates[candidates.length - 1]; // largest under limit
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sena-'));
        const safeTitle = (info.title || 'video').replace(/[\s\\/:*?"<>|]+/g, '_').slice(0, 40);
        const ext = best.ext || 'mp4';
        const name = `${safeTitle}_${best.format_id}.${ext}`;
        const outPath = path.join(tmpDir, name);
        try {
            await youtubedl(url, {
                f: best.format_id,
                output: outPath,
                noWarnings: true,
                noCheckCertificates: true,
                restrictFilenames: true,
                referer: url
            });
                    return { type: 'file', path: outPath, name, directUrl: bestAvStream?.url };
        } catch (e) {
            // fallback to link
        }
    }

    // If we can't attach, try to provide a direct media URL (best we can)
        try {
            if (bestAvStream && bestAvStream.url) {
                return { type: 'link', url: bestAvStream.url };
            }
        } catch {}

    return { type: 'error' };
}

function isSupportedSocialUrl(u) {
    try {
        const host = new URL(u).hostname.toLowerCase();
        const bases = [
            'twitter.com','x.com','fxtwitter.com','vxtwitter.com','mobile.twitter.com',
            'reddit.com','www.reddit.com','redd.it','rxddit.com','v.redd.it',
            'tiktok.com','www.tiktok.com','vxtiktok.com',
            'instagram.com','www.instagram.com','ddinstagram.com',
            'facebook.com','www.facebook.com','web.facebook.com','fb.watch'
        ];
        return bases.some(b => host === b || host.endsWith('.' + b.replace(/^www\./,'')));
    } catch { return false; }
}

async function fetchSocialMeta(url) {
    const json = await youtubedl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        referer: url
    });
    return {
        title: json.title,
        description: json.description,
        thumbnail: json.thumbnail,
        duration: json.duration,
        uploader: json.uploader || json.uploader_id || json.channel
    };
}
// Twitter meta via fxtwitter API for reliable media extraction
async function fetchTwitterMeta(fixedUrl) {
    // Expect fixedUrl like https://fxtwitter.com/user/status/123...
    const match = fixedUrl.match(/status\/(\d+)/);
    if (!match) throw new Error('No status id');
    const id = match[1];
    const apiUrl = `https://api.fxtwitter.com/status/${id}`;
    const res = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0 SenaBot' }});
    if (!res.ok) throw new Error('fxtwitter api ' + res.status);
    const data = await res.json();
    if (!data.tweet) throw new Error('No tweet data');
    const t = data.tweet;
    const images = [];
    const videos = [];
    if (Array.isArray(t.media?.photos)) {
        for (const p of t.media.photos) if (p.url) images.push(p.url);
    }
    if (Array.isArray(t.media?.videos)) {
        // take highest bitrate variant
        for (const v of t.media.videos) {
            if (Array.isArray(v.variants)) {
                const best = [...v.variants].sort((a,b)=> (b.bitrate||0)-(a.bitrate||0))[0];
                if (best?.url) videos.push(best.url);
            }
        }
    }
    return {
        title: t.text?.slice(0, 180) || 'Tweet',
        description: t.text || undefined,
        uploader: t.author?.name || t.author?.screen_name,
        images,
        videos,
        thumbnail: images[0]
    };
}

// Facebook meta scraping
async function fetchFacebookMeta(fixedUrl) {
    const res = await fetch(fixedUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
    if (!res.ok) throw new Error('fb fetch ' + res.status);
    const html = await res.text();
    const og = await extractOgFromHtml(html);
    return og || null;
}

async function fetchOpenGraphMeta(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 SenaBot', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
    if (!res.ok) throw new Error('OG fetch failed ' + res.status);
    const html = await res.text();
    return extractOgFromHtml(html);
}

function extractOgFromHtml(html) {
    const og = {};
    const metaRegex = /<meta[^>]+?>/gi;
    const tags = html.match(metaRegex) || [];
    const images = [];
    for (const tag of tags) {
        const prop = /property=["']([^"']+)["']/i.exec(tag)?.[1] || /name=["']([^"']+)["']/i.exec(tag)?.[1];
        const content = /content=["']([^"']+)["']/i.exec(tag)?.[1];
        if (!prop || !content) continue;
        const key = prop.toLowerCase();
        if (key === 'og:title') og.title = content;
        else if (key === 'og:description') og.description = content;
        else if (key === 'og:image' || key === 'og:image:url') {
            images.push(content);
        }
    }
    if (images.length) og.thumbnail = images[0];
    if (images.length) og.images = images;
    if (!og.title && !og.thumbnail && !og.description) return null;
    return og;
}

// --------------------------------------------
//           Danbooru / Safebooru helper
// --------------------------------------------

async function fetchRandomDanbooruPost(rawTags, { safeOnly }) {
    // Danbooru rating codes: g = general, s = sensitive, q = questionable, e = explicit
    // - safeOnly (for /safebooru): restrict to general + sensitive
    // - !safeOnly (for /booru): restrict to explicit only
    const ratingFilter = safeOnly ? 'rating:g,s' : 'rating:e';

    // Allow loose, human-friendly input like "shiina mahiru" or "mahiru shiina"
    // by converting each word into a wildcard tag (e.g. *shiina* *mahiru*).
    const words = (rawTags || '')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(w => w.length > 0);
    const fuzzyTags = words.map(w => `*${w}*`).join(' ');

    const tags = [fuzzyTags, ratingFilter].filter(Boolean).join(' ').trim();

    const params = new URLSearchParams({
        'limit': '50',
        'random': 'true'
    });
    if (tags) params.set('tags', tags);

    const url = `https://danbooru.donmai.us/posts.json?${params.toString()}`;

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'SenaDiscordBot/1.0 (+https://discordapp.com)',
            'Accept': 'application/json'
        }
    });
    if (!res.ok) throw new Error('Danbooru HTTP ' + res.status);
    const posts = await res.json();
    if (!Array.isArray(posts) || !posts.length) return null;

    // Extra safety filter on our side
    const allowedRatings = safeOnly ? new Set(['g', 's']) : new Set(['e']);
    const filtered = posts.filter(p => allowedRatings.has(p.rating));
    const list = filtered.length ? filtered : posts;

    const choice = list[Math.floor(Math.random() * list.length)];
    return choice || null;
}

const KNOWN_OSU_MODS = new Set([
    'NF','EZ','TD','HD','HR','SD','PF','NC','DT','HT','DC','FL','SO','AP','FI','RN','TP','V2','MR',
    '1K','2K','3K','4K','5K','6K','7K','8K','9K','10','LC','K9','K8','K7','K6','K5','K4','K3','K2','K1'
]);

function parseModsString(raw) {
    if (!raw) return [];
    const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!cleaned) return [];
    const mods = [];
    for (let i = 0; i < cleaned.length; i += 2) {
        const chunk = cleaned.slice(i, i + 2);
        if (chunk.length === 2 && KNOWN_OSU_MODS.has(chunk)) {
            mods.push(chunk);
        }
    }
    if (mods.includes('NC') && !mods.includes('DT')) mods.push('DT');
    if (mods.includes('PF') && !mods.includes('SD')) mods.push('SD');
    return mods;
}

function extractBeatmapIds(input) {
    const ids = { beatmapId: null, beatmapsetId: null };
    if (!input) return ids;

    const trimmed = input.trim();
    const sanitized = trimmed.startsWith('<') && trimmed.endsWith('>')
        ? trimmed.slice(1, -1)
        : trimmed;

    const tryAssign = (key, value) => {
        if (ids[key] != null || value == null) return;
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) ids[key] = parsed;
    };

    let parsedUrl = null;
    try {
        parsedUrl = new URL(sanitized);
    } catch {
        parsedUrl = null;
    }

    const textSources = [sanitized];
    if (parsedUrl) {
        textSources.push(parsedUrl.pathname, parsedUrl.hash, parsedUrl.search);

        // Query params like ?b=123, ?s=456
        tryAssign('beatmapId', parsedUrl.searchParams?.get('b'));
        tryAssign('beatmapsetId', parsedUrl.searchParams?.get('s'));
    }

    const patterns = [
        { regex: /beatmapsets\/(\d+)/i, key: 'beatmapsetId' },
        { regex: /(?:^|[#?/])(osu|taiko|fruits|mania)\/(\d+)/i, key: 'beatmapId', groupIndex: 2 },
        { regex: /(?:beatmaps|b)\/(\d+)/i, key: 'beatmapId' },
        { regex: /(?:set|s)=?(\d+)/i, key: 'beatmapsetId' },
        { regex: /(?:beatmap|b)=?(\d+)/i, key: 'beatmapId' },
    ];

    for (const source of textSources) {
        if (!source) continue;
        for (const pattern of patterns) {
            const match = source.match(pattern.regex);
            if (match) {
                const value = pattern.groupIndex ? match[pattern.groupIndex] : match[1];
                tryAssign(pattern.key, value);
            }
        }
    }

    // Hash fragments sometimes contain multiple IDs; grab the last numeric chunk.
    if (parsedUrl?.hash && ids.beatmapId == null) {
        const nums = parsedUrl.hash.match(/(\d+)/g);
        if (nums && nums.length) {
            tryAssign('beatmapId', nums[nums.length - 1]);
        }
    }

    // Plain numeric input => beatmap ID by default.
    if (ids.beatmapId == null && /^\d+$/.test(sanitized)) {
        tryAssign('beatmapId', sanitized);
    }

    return ids;
}

function formatOsuTopLine(score, absoluteRank) {
    const beatmap = score.beatmap || {};
    const beatmapset = beatmap.beatmapset || score.beatmapset || {};
    const artist = beatmapset.artist || beatmap.artist || 'Unknown artist';
    const title = beatmapset.title || beatmap.title || 'Unknown title';
    const diff = beatmap.version || 'Unknown difficulty';
    const mods = score.mods?.length ? `+${score.mods.join('')}` : 'No Mod';
    const pp = score.pp != null ? `${score.pp.toFixed(2)}pp` : 'PP N/A';
    const acc = score.accuracy != null ? `${(score.accuracy * 100).toFixed(2)}%` : 'Unknown acc';
    const rank = score.rank || 'N/A';
    const sr = beatmap.difficulty_rating != null ? `${beatmap.difficulty_rating.toFixed(2)}★` : '';
    const time = score.ended_at || score.created_at;
    const relative = time ? `<t:${Math.floor(new Date(time).getTime() / 1000)}:R>` : 'Unknown time';
    let combo = 'Combo N/A';
    if (score.max_combo != null && beatmap.max_combo != null) {
        combo = `${score.max_combo}x / ${beatmap.max_combo}x`;
    } else if (score.max_combo != null) {
        combo = `${score.max_combo}x`;
    } else if (beatmap.max_combo != null) {
        combo = `${beatmap.max_combo}x max`;
    }
    const missCount = score.statistics?.count_miss ?? 0;
    const mapUrl = beatmap.id ? `https://osu.ppy.sh/beatmaps/${beatmap.id}` : null;

    let line = `**#${absoluteRank}** ${pp} — ${artist} - ${title} [${diff}]`;
    if (mods !== 'No Mod') line += ` (${mods})`;
    line += `\n${acc} • Rank ${rank}${sr ? ` • ${sr}` : ''} • ${combo} • Misses: ${missCount} • ${relative}`;
    if (mapUrl) line += ` • [Link](${mapUrl})`;
    return line;
}

function getBeatmapArtFromScore(score) {
    if (!score) return { cover: null, thumbnail: null };
    const beatmap = score.beatmap || {};
    const beatmapset = beatmap.beatmapset || score.beatmapset || {};
    const coverBase = beatmapset.id ? `https://assets.ppy.sh/beatmaps/${beatmapset.id}/covers` : null;
    const cover = beatmapset?.covers?.['cover@2x']
        || beatmapset?.covers?.cover
        || (coverBase ? `${coverBase}/cover.jpg` : null);
    const thumbnail = beatmapset?.covers?.list
        || beatmapset?.covers?.card
        || (coverBase ? `${coverBase}/list.jpg` : null);
    return { cover, thumbnail };
}

async function buildOsuRecentEmbedFromScore(score, { title = 'Most Recent osu! Play' } = {}) {
    if (!score) {
        throw new Error('No recent osu! score provided');
    }

    let beatmap = score.beatmap || null;
    let beatmapset = beatmap?.beatmapset || score?.beatmapset || null;
    const beatmapId = beatmap?.id
        ?? score?.beatmap?.id
        ?? score?.beatmap_id
        ?? score?.beatmap?.beatmap_id
        ?? null;
    let beatmapsetId = beatmapset?.id
        ?? beatmap?.beatmapset_id
        ?? score?.beatmapset_id
        ?? score?.beatmap?.beatmapset_id
        ?? null;
    const user = score.user || (score.user_id ? { id: score.user_id, username: OSU_USERNAME } : null);

    if ((!beatmap || !beatmapset) && beatmapId) {
        try {
            const fetched = await fetchOsuBeatmap(beatmapId);
            if (fetched) {
                beatmap = fetched;
                beatmapset = fetched?.beatmapset || beatmapset;
                beatmapsetId = beatmapset?.id || fetched?.beatmapset_id || beatmapsetId;
            }
        } catch (err) {
            console.warn('[osu recent embed] beatmap fetch failed', err);
        }
    }

    if (!beatmapset && beatmapsetId) {
        try {
            beatmapset = await fetchOsuBeatmapset(beatmapsetId);
        } catch (err) {
            console.warn('[osu recent embed] beatmapset fetch failed', err);
        }
    }

    if (!beatmapsetId) {
        beatmapsetId = beatmapset?.id || null;
    }

    let fcPp = null;
    let attrs = null;
    if (beatmapId) {
        try {
            attrs = await fetchOsuBeatmapAttributes(beatmapId, score.mods || [], 'osu');
            const fcCandidate = Number(attrs?.attributes?.pp);
            fcPp = Number.isFinite(fcCandidate) ? fcCandidate : null;
        } catch (err) {
            console.warn('[osu recent embed] beatmap attributes fetch failed', err);
        }
    }

    const mods = (score.mods && score.mods.length) ? score.mods.join(', ') : 'None';
    const acc = score.accuracy != null ? `${(score.accuracy * 100).toFixed(2)}%` : 'Unknown';
    const pp = score.pp != null ? `${score.pp.toFixed(2)}pp` : 'N/A';
    const fcPpDisplay = fcPp != null ? `${fcPp.toFixed(2)}pp` : 'Unknown';
    const combo = score.max_combo != null ? `${score.max_combo}x` : 'Unknown';
    const mapRank = Number.isFinite(score.rank_global ?? score.position)
        ? (score.rank_global ?? score.position)
        : null;
    const rank = score.rank || 'N/A';
    const result = score.passed ? 'Clear' : 'Fail';

    const time = score.ended_at || score.created_at;
    const timestamp = time ? `<t:${Math.floor(new Date(time).getTime() / 1000)}:R>` : 'Unknown';

    const artist = beatmapset?.artist || beatmap?.artist || 'Unknown artist';
    const titleName = beatmapset?.title || beatmap?.title || 'Unknown title';
    const diffName = beatmap?.version || 'Unknown difficulty';
    const mapper = beatmapset?.creator || beatmap?.creator || 'Unknown mapper';

    const fullTitleCore = `${artist} - ${titleName} [${diffName}]`;

    const bmUrl = beatmapId ? `https://osu.ppy.sh/beatmaps/${beatmapId}` : undefined;
    const userUrl = user ? `https://osu.ppy.sh/users/${user.id}` : undefined;
    const fallbackCoverBase = beatmapsetId ? `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers` : null;
    const coverImage = beatmapset?.covers?.['cover@2x']
        || beatmapset?.covers?.cover
        || (fallbackCoverBase ? `${fallbackCoverBase}/cover.jpg` : null);
    const thumbnailImage = beatmapset?.covers?.list
        || beatmapset?.covers?.card
        || (fallbackCoverBase ? `${fallbackCoverBase}/list.jpg` : null);
    const bannerImage = beatmapset?.covers?.card || coverImage;
    const playerAvatar = user?.avatar_url;

    // Difficulty / technical stats
    const rawSr = attrs?.attributes?.star_rating ?? beatmap?.difficulty_rating;
    const starRating = Number.isFinite(rawSr) ? `${rawSr.toFixed(2)}★` : 'N/A';
    const bpm = beatmap?.bpm != null ? `${beatmap.bpm}` : 'N/A';
    const ar = beatmap?.ar != null ? `${beatmap.ar}` : 'N/A';
    // Some API payloads use 'accuracy' others 'od' for Overall Difficulty
    const od = beatmap?.accuracy != null ? `${beatmap.accuracy}` : (beatmap?.od != null ? `${beatmap.od}` : 'N/A');
    const cs = beatmap?.cs != null ? `${beatmap.cs}` : 'N/A';
    const hp = beatmap?.drain != null ? `${beatmap.drain}` : 'N/A';
    const lengthSec = beatmap?.hit_length != null ? beatmap.hit_length : beatmap?.total_length;
    const lengthDisplay = Number.isFinite(lengthSec) ? formatDuration(lengthSec) : 'N/A';
    const difficultyDetails = `Length: ${lengthDisplay}\nBPM: ${bpm}\nAR: ${ar}\nOD: ${od}\nCS: ${cs}\nHP: ${hp}`;

    const placementSuffix = Number.isFinite(mapRank) ? ` (#${mapRank.toLocaleString()})` : '';

    const embed = new EmbedBuilder()
        .setColor(0xffaacc)
        .setTitle(title)
        .setDescription(`${fullTitleCore} — ${starRating}${placementSuffix}`)
        .addFields(
            // Row 1
            { name: 'Result', value: `${result} (${rank})`, inline: true },
            { name: 'PP', value: pp, inline: true },
            { name: 'FC PP', value: fcPpDisplay, inline: true },
            // Row 2
            { name: 'Accuracy', value: acc, inline: true },
            { name: 'Combo', value: combo, inline: true },
            { name: 'Score', value: score.score != null ? score.score.toLocaleString() : 'Unknown', inline: true },
            // Row 3
            { name: 'Mods', value: mods, inline: true },
            { name: 'Difficulty', value: difficultyDetails, inline: false },
            { name: 'Mapper', value: mapper, inline: true },
            // Footer style info (non-inline for clear separation)
            { name: 'When', value: timestamp, inline: false },
        );

    if (bmUrl) embed.setURL(bmUrl);
    // Thumbnail: show player avatar (cleaner; map art already shown below)
    if (playerAvatar) embed.setThumbnail(playerAvatar);
    if (coverImage) embed.setImage(coverImage);
    else if (bannerImage) embed.setImage(bannerImage);

    if (userUrl) embed.setFooter({ text: `Player: ${user?.username || OSU_USERNAME}` });

    return embed;
}

function getOsuScoreKey(score) {
    if (!score) return null;
    const endedAt = score.ended_at || score.created_at || '';
    const id = score.id ?? score.score_id ?? `${score.user_id ?? 'unknown'}`;
    return `${id}:${endedAt}`;
}

async function resolveOsuRecentChannel() {
    if (!OSU_RECENT_CHANNEL_ID) return null;
    if (osuRecentWatcher.channel?.isTextBased?.()) {
        return osuRecentWatcher.channel;
    }

    try {
        const channel = await client.channels.fetch(OSU_RECENT_CHANNEL_ID);
        if (channel?.isTextBased?.()) {
            osuRecentWatcher.channel = channel;
            return channel;
        }
        console.warn(`[osu recent watcher] Channel ${OSU_RECENT_CHANNEL_ID} is not text-based or visible.`);
    } catch (err) {
        console.error('[osu recent watcher] channel fetch failed', err);
    }
    return null;
}

async function startOsuRecentWatcher() {
    if (!OSU_RECENT_CHANNEL_ID) return;
    if (!OSU_USERNAME) {
        console.warn('[osu recent watcher] OSU_USERNAME not configured — cannot start watcher.');
        return;
    }
    if (osuRecentWatcher.timer) return;

    const channel = await resolveOsuRecentChannel();
    if (!channel) return;

    try {
        const primeScores = await fetchOsuRecent('osu');
        const primeScore = Array.isArray(primeScores) ? primeScores[0] : null;
        const key = getOsuScoreKey(primeScore);
        if (key) {
            osuRecentWatcher.lastScoreKey = key;
            console.log('[osu recent watcher] Primed with latest known score; announcements will begin with the next new play.');
        }
    } catch (err) {
        console.warn('[osu recent watcher] Failed to prime state', err);
    }

    console.log(`[osu recent watcher] Tracking recent plays in #${channel.name || channel.id} every ${Math.round(OSU_RECENT_POLL_INTERVAL / 1000)}s`);
    const runner = () => {
        runOsuRecentAutoCheck().catch(err => console.error('[osu recent watcher] poll failed', err));
    };

    await runOsuRecentAutoCheck();
    osuRecentWatcher.timer = setInterval(runner, OSU_RECENT_POLL_INTERVAL);
    if (typeof osuRecentWatcher.timer?.unref === 'function') {
        osuRecentWatcher.timer.unref();
    }
}

async function runOsuRecentAutoCheck() {
    if (!OSU_RECENT_CHANNEL_ID || !OSU_USERNAME) return;
    const channel = await resolveOsuRecentChannel();
    if (!channel) return;

    try {
        const scores = await fetchOsuRecent('osu');
        if (!Array.isArray(scores) || !scores.length) return;

        const score = scores[0];
        const uniqueKey = getOsuScoreKey(score);
        if (!uniqueKey) return;
        if (osuRecentWatcher.lastScoreKey && uniqueKey === osuRecentWatcher.lastScoreKey) {
            return;
        }

        const username = score.user?.username || OSU_USERNAME;
        const embed = await buildOsuRecentEmbedFromScore(score, { title: `${username} just played!` });
        await channel.send({ embeds: [embed] });
        osuRecentWatcher.lastScoreKey = uniqueKey;
    } catch (err) {
        console.error('[osu recent watcher] update failed', err);
    }
}

function applyBotPresence() {
    if (!client?.user) return;
    const resolvedType = ACTIVITY_TYPE_MAP.get(BOT_STATUS_TYPE) ?? ActivityType.Playing;
    const validStates = new Set(['online', 'idle', 'dnd', 'invisible']);
    const status = validStates.has(BOT_STATUS_STATE) ? BOT_STATUS_STATE : 'online';

    const activities = [];
    if (BOT_STATUS_TEXT) {
        const activity = {
            name: BOT_STATUS_TEXT,
            type: resolvedType,
        };
        if (resolvedType === ActivityType.Streaming) {
            if (BOT_STATUS_STREAM_URL) {
                activity.url = BOT_STATUS_STREAM_URL;
            } else {
                activity.type = ActivityType.Playing;
            }
        }
        activities.push(activity);
    }

    try {
        client.user.setPresence({ status, activities });
    } catch (err) {
        console.warn('[presence] failed to set Discord presence', err);
    }
}

function buildOsuTopPage(session, requestedPage) {
    const total = session.scores.length;
    const perPage = session.perPage;
    const totalPages = Math.max(1, Math.ceil(Math.max(1, total) / perPage));
    const maxPageIndex = Math.max(0, totalPages - 1);
    const page = Math.min(Math.max(requestedPage, 0), maxPageIndex);
    const start = page * perPage;
    const slice = session.scores.slice(start, start + perPage);
    const description = slice
        .map((score, idx) => formatOsuTopLine(score, start + idx + 1))
        .join('\n\n') || 'No plays to display.';

    const displayStart = slice.length ? start + 1 : Math.max(1, start + 1);
    const displayEnd = slice.length ? start + slice.length : Math.max(start + slice.length, displayStart);

    const embed = new EmbedBuilder()
        .setColor(0xffaacc)
        .setTitle(`osu! Top Plays — ${session.displayName}`)
        .setDescription(description)
        .setFooter({
            text: `Page ${page + 1}/${session.reachedEnd ? totalPages : totalPages + '+'} • Showing ${displayStart}-${displayEnd} of ${session.reachedEnd ? total : total + '+'}`,
        });

    const heroScore = slice[0] || session.scores[0] || null;
    const art = getBeatmapArtFromScore(heroScore);
    const thumbnailImage = art.thumbnail || session.thumbnailImage || null;
    const coverImage = art.cover || session.coverImage || null;

    if (thumbnailImage) embed.setThumbnail(thumbnailImage);
    if (coverImage) embed.setImage(coverImage);

    const components = [];
    const canGoBackward = page > 0;
    const canGoForward = !session.reachedEnd || page < maxPageIndex;
    const shouldShowRow = canGoBackward || canGoForward;
    if (shouldShowRow) {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`osutop:${session.id}:${page - 1}`)
                    .setEmoji('⬅️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!canGoBackward),
                new ButtonBuilder()
                    .setCustomId(`osutop:${session.id}:${page + 1}`)
                    .setEmoji('➡️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!canGoForward),
            );
        components.push(row);
    }

    return { embed, components, page, totalPages };
}

async function ensureOsuTopDataForPage(session, page) {
    const perPage = session.perPage;
    const requiredCount = (page + 1) * perPage;
    if (session.scores.length >= requiredCount || session.reachedEnd) return;

    if (!session.loadingPromise) {
        session.loadingPromise = (async () => {
            while (session.scores.length < requiredCount && !session.reachedEnd) {
                const chunk = await fetchOsuTopScores(session.chunkSize, session.mode, session.nextOffset);
                if (Array.isArray(chunk) && chunk.length) {
                    session.scores.push(...chunk);
                    session.nextOffset += chunk.length;
                    if (chunk.length < session.chunkSize) {
                        session.reachedEnd = true;
                    }
                } else {
                    session.reachedEnd = true;
                }
            }
        })().finally(() => {
            session.loadingPromise = null;
        });
    }

    await session.loadingPromise;
}