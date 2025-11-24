// deploy-commands.js
// deploy-commands.js (ESM)
import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

// Support either DISCORD_TOKEN (used in index.js) or BOT_TOKEN (older/alternate name)
const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
if (!token || !clientId) {
  console.error('Please set DISCORD_TOKEN (or BOT_TOKEN) and CLIENT_ID in .env');
  process.exit(1);
}

const commands = [
  {
    name: 'play',
    description: 'Play a song by title or YouTube link',
    options: [
      {
        name: 'query',
        type: 3, // STRING
        description: 'Song title or YouTube link',
        required: true
      }
    ]
  },
  {
    name: 'playsong',
    description: 'Search for songs and choose from top 3 results',
    options: [
      {
        name: 'query',
        type: 3, // STRING
        description: 'Song title or artist to search for',
        required: true
      }
    ]
  },
  {
    name: 'download',
    description: 'Download media from social links and attach if <=8MB',
    options: [
      {
        name: 'url',
        type: 3,
        description: 'Media URL (X/Twitter, Reddit, TikTok, Instagram, Facebook)',
        required: true
      }
    ]
  },
  {
    name: 'queue',
    description: 'Show the current queue'
  },
  {
    name: 'remove',
    description: 'Remove a song by its position in the queue (1-based)',
    options: [
      {
        name: 'index',
        type: 4, // INTEGER
        description: 'Queue position (1 = first)',
        required: true
      }
    ]
  },
  {
    name: 'shuffle',
    description: 'Shuffle the queue'
  },
  {
    name: 'volume',
    description: 'Set playback volume (0-100)',
    options: [
      {
        name: 'value',
        type: 4,
        description: 'Volume percent',
        required: true
      }
    ]
  },
  {
    name: 'skip',
    description: 'Skip the currently playing song.'
  },
  {
    name: 'stop',
    description: 'Stop playback and clear the queue.'
  },
  {
    name: 'pause',
    description: 'Pause the currently playing song.'
  },
  {
    name: 'resume',
    description: 'Resume a paused song.'
  },
  {
    name: 'nowplaying',
    description: 'Show the currently playing song.'
  },
  {
    name: 'safebooru',
    description: 'Get a random SFW image (general/sensitive) from booru with optional tags.',
    options: [
      {
        name: 'tags',
        type: 3,
        description: 'Optional tags, separated by spaces',
        required: false
      }
    ]
  },
  {
    name: 'booru',
    description: 'Get a random image from booru (NSFW allowed, NSFW channels only).',
    options: [
      {
        name: 'tags',
        type: 3,
        description: 'Optional tags, separated by spaces',
        required: false
      }
    ]
  },
  {
    name: 'help',
    description: 'Show a list of available commands'
  },
  {
    name: 'profile',
    description: 'Show your Discord profile information'
  },
  {
    name: 'osuprofile',
    description: 'Show osu! profile stats for the configured user'
  },
  {
    name: 'osurecent',
    description: 'Show the most recent osu! play for the configured user'
  },
  {
    name: 'osutop',
    description: 'Show top osu! plays for the configured user',
    options: [
      {
        name: 'limit',
        type: 4,
        description: 'How many top plays to show (1-25)',
        required: false
      }
    ]
  },
  {
    name: 'osumap',
    description: 'Show beatmap details and estimated PP for a specific osu! map',
    options: [
      {
        name: 'map',
        type: 3,
        description: 'Beatmap link or ID',
        required: true
      },
      {
        name: 'mods',
        type: 3,
        description: 'Optional mod string (e.g., HDHR, +DT)',
        required: false
      }
    ]
  },
  {
    name: 'valo',
    description: 'Show Valorant profile stats for the configured player.'
  },
  {
    name: 'valorecent',
    description: 'Show the most recent Valorant match for the configured player.'
  }
];

const rest = new REST({ version: '10' }).setToken(token);

async function registerCommands() {
  try {
    console.log('⛅ Registering global slash commands…');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Global commands registered. Propagation may take up to an hour.');
  } catch (err) {
    console.error('❌ Failed to register global commands:', err);
  }
}

registerCommands();
