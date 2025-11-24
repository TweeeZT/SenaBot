# Sena Discord Bot

Custom Discord bot for music playback, osu! stats, Valorant highlights, and social media helpers.

## Features

### Music Commands

- `/play <query>` - Play a song by title or YouTube link
- `/playsong <query>` - Search and choose from top 3 results with thumbnails
- `/queue` - View current queue with pagination (20 songs per page)
- `/skip` - Skip the currently playing song
- `/shuffle` - Shuffle the queue with visual preview
- `/pause` / `/resume` - Control playback
- `/nowplaying` - Show current song details
- `/remove <index>` - Remove a song from queue
- `/stop` - Stop playback and clear queue

### osu! Commands

- `/osuprofile` - Show configured user's osu! profile stats
- `/osurecent` - Show most recent play
- `/osutop [limit]` - Show top plays (1-25)
- `/osumap <map> [mods]` - Show beatmap details and estimated PP
- Automatic recent-play feed to configured channel

### Valorant Commands

- `/valo` - Show Valorant profile (rank, RR, recent form, headshot rate)
- `/valorecent` - Latest match breakdown with KDA, ADR/ACS, and scoreboard

### Image Commands

- `/safebooru [tags]` - Random SFW image from Danbooru (general/sensitive ratings)
- `/booru [tags]` - Random image from Danbooru (NSFW allowed in NSFW channels only)
- Both commands include links to original high-res image and Danbooru post

### Utility Commands

- `/download <url>` - Download media from social links (Twitter/X, TikTok, Reddit, Instagram, Facebook)
- `/profile` - Show your Discord profile information
- `/help` - List all available commands

## Getting Started

### Prerequisites

- Node.js 16.9.0 or higher
- Discord Bot Token ([Discord Developer Portal](https://discord.com/developers/applications))
- FFmpeg (automatically included via `ffmpeg-static`)

### Installation

1. Clone the repository:

   ```powershell
   git clone https://github.com/yourusername/sena-discord-bot.git
   cd sena-discord-bot
   ```

2. Install dependencies:

   ```powershell
   npm install
   ```

3. Configure environment variables:

   - Copy `.env.example` to `.env`
   - Fill in your Discord bot token and other API credentials

   ```powershell
   copy .env.example .env
   ```

4. Register slash commands:

   ```powershell
   npm run deploy-commands
   ```

5. Start the bot:
   ```powershell
   npm start
   ```

## Environment Variables

Copy `.env.example` to `.env` and configure the following:

### Required

- `DISCORD_TOKEN` - Your Discord bot token
- `CLIENT_ID` - Your Discord application ID

### Optional - Music Player

- `MAX_PLAYLIST_LENGTH` - Maximum songs to load from playlists (default: 400)

### Optional - osu! Integration

- `OSU_CLIENT_ID` - osu! API v2 client ID
- `OSU_CLIENT_SECRET` - osu! API v2 client secret
- `OSU_USERNAME` - Your osu! username
- `OSU_USER_ID` - Your osu! user ID
- `OSU_RECENT_CHANNEL_ID` - Discord channel for automatic recent-play feed
- `OSU_RECENT_POLL_SECONDS` - Polling interval for recent plays (default: 60)

### Optional - Valorant Integration

- `VALORANT_NAME` - Valorant display name
- `VALORANT_TAG` - Valorant tag (without #)
- `VALORANT_REGION` - Region code (na, eu, ap, kr, latam, br)
- `HENRIK_API_KEY` - HenrikDev API key ([Get one here](https://docs.henrikdev.xyz/))
- `TRACKER_GG_API_KEY` - Alternative Tracker.gg API key
- `VALORANT_API_PROVIDER` - API provider (`tracker` or leave empty for HenrikDev)

### Optional - Bot Presence

- `BOT_STATUS_TEXT` - Status text (e.g., "with /play")
- `BOT_STATUS_TYPE` - Activity type (PLAYING, LISTENING, WATCHING, COMPETING, STREAMING)
- `BOT_STATUS_STATE` - Online state (online, idle, dnd, invisible)
- `BOT_STATUS_STREAM_URL` - Stream URL (required if type is STREAMING)

## Notes

- **Large Playlist Support**: The bot can load playlists up to 500 songs using dual-loading strategy (play-dl with yt-dlp fallback)
- **Queue Pagination**: Queues display 20 songs per page with ◀▶ navigation buttons
- **API Rate Limits**: osu! and Valorant APIs are rate-limited; avoid running multiple instances
- **Security**: Never commit your `.env` file - it's already excluded in `.gitignore`
- **Music Quality**: Uses FFmpeg for high-quality audio transcoding
- **Booru Images**: `/safebooru` is SFW-only (general/sensitive), `/booru` allows NSFW in NSFW channels only

## Dependencies

- **discord.js** - Discord bot framework
- **@discordjs/voice** - Voice connection and audio playback
- **play-dl** - YouTube search and streaming
- **yt-dlp-exec** - Fallback for large playlists and social media downloads
- **ffmpeg-static** - Bundled FFmpeg for audio processing
- **dotenv** - Environment variable management

## License

ISC

## Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.

## Support

For issues or questions, please open an issue on GitHub.
