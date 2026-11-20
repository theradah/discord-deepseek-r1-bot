require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
} = require('discord.js');

// --- Configuration ---
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
  .trim()
  .replace(/\/+$/, '');
const DEFAULT_MODEL = (process.env.DEEPSEEK_MODEL || 'deepseek-reasoner').trim();
const SYSTEM_PROMPT =
  (process.env.SYSTEM_PROMPT || '').trim() ||
  'You are a helpful, concise, and intelligent AI assistant on Discord powered by DeepSeek.';

const MAX_HISTORY_TURNS = 10;
const DISCORD_MAX_LEN = 1900;

if (!DISCORD_TOKEN) {
  console.error('[ERROR] Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}
if (!DEEPSEEK_API_KEY) {
  console.error('[ERROR] Missing DEEPSEEK_API_KEY environment variable.');
  process.exit(1);
}

// Per-channel/user conversation history and selected model
const conversationHistory = new Map();
const channelModels = new Map();

function getHistoryKey(channelId, userId) {
  return `${channelId}:${userId}`;
}

function getModel(channelId) {
  return channelModels.get(channelId) || DEFAULT_MODEL;
}

function appendHistory(key, userContent, assistantContent) {
  const history = conversationHistory.get(key) || [];
  history.push({ role: 'user', content: userContent });
  history.push({ role: 'assistant', content: assistantContent });
  while (history.length > MAX_HISTORY_TURNS * 2) {
    history.shift();
  }
  conversationHistory.set(key, history);
}

// --- DeepSeek API Client ---
async function queryDeepSeek(prompt, historyKey, modelOverride) {
  const history = conversationHistory.get(historyKey) || [];
  const model = modelOverride || DEFAULT_MODEL;

  // Build strictly alternating messages for compatibility with deepseek-reasoner
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const msg of history) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content += `\n\n${msg.content}`;
    } else {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    last.content += `\n\n${prompt}`;
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const endpoint = `${DEEPSEEK_BASE_URL}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`DeepSeek API error (${response.status}): ${errText || response.statusText}`);
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0] && data.choices[0].message;
  if (!choice) {
    throw new Error('Empty response received from DeepSeek API.');
  }

  const answer = (choice.content || '').trim() || '*(No response content)*';
  const reasoning = (choice.reasoning_content || '').trim();

  appendHistory(historyKey, prompt, answer);

  return { answer, reasoning, model };
}

// --- Message Formatting & Splitting ---
function formatResponse({ answer, reasoning }) {
  if (!reasoning) {
    return answer;
  }
  const maxReasonLen = 700;
  const trimmedReasoning =
    reasoning.length > maxReasonLen
      ? `${reasoning.slice(0, maxReasonLen).trim()}...`
      : reasoning;
  const quotedReasoning = trimmedReasoning
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `**Thinking Process:**\n||${quotedReasoning}||\n\n${answer}`;
}

function splitMessage(text, maxLength = DISCORD_MAX_LEN) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < maxLength * 0.4) {
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < maxLength * 0.4) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// --- Slash Commands Definition ---
const slashCommands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask DeepSeek a question')
    .addStringOption((opt) =>
      opt.setName('prompt').setDescription('Your message or question').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('model')
        .setDescription('Choose DeepSeek model for this prompt')
        .setRequired(false)
        .addChoices(
          { name: 'DeepSeek R1 (deepseek-reasoner)', value: 'deepseek-reasoner' },
          { name: 'DeepSeek V3 (deepseek-chat)', value: 'deepseek-chat' }
        )
    ),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Switch the active DeepSeek model for this channel')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Model name')
        .setRequired(true)
        .addChoices(
          { name: 'DeepSeek R1 (deepseek-reasoner)', value: 'deepseek-reasoner' },
          { name: 'DeepSeek V3 (deepseek-chat)', value: 'deepseek-chat' }
        )
    ),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear your conversation history with DeepSeek in this channel'),
].map((cmd) => cmd.toJSON());

async function registerSlashCommands(clientId) {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(clientId), { body: slashCommands });
    console.log('[INFO] Slash commands (/ask, /model, /reset) registered globally.');
  } catch (err) {
    console.warn('[WARN] Could not register slash commands:', err.message);
  }
}

// --- Bot Setup & Automatic Intent Fallback ---
function createBotClient(includeMessageContentIntent = true) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ];
  if (includeMessageContentIntent) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  const client = new Client({
    intents,
    partials: [Partials.Channel, Partials.Message],
  });

  client.once('ready', async (readyClient) => {
    console.log(`[READY] Logged in as ${readyClient.user.tag}`);
    console.log(`[CONFIG] Base URL: ${DEEPSEEK_BASE_URL} | Default Model: ${DEFAULT_MODEL}`);
    await registerSlashCommands(readyClient.user.id);
  });

  // Handle Slash Commands
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const historyKey = getHistoryKey(interaction.channelId, interaction.user.id);

    if (interaction.commandName === 'reset') {
      conversationHistory.delete(historyKey);
      await interaction.reply({
        content: 'Conversation history cleared!',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'model') {
      const selectedModel = interaction.options.getString('name', true);
      channelModels.set(interaction.channelId, selectedModel);
      await interaction.reply(
        `Active model for this channel set to **${selectedModel}**.`
      );
      return;
    }

    if (interaction.commandName === 'ask') {
      const prompt = interaction.options.getString('prompt', true);
      const modelChoice =
        interaction.options.getString('model', false) || getModel(interaction.channelId);

      await interaction.deferReply();
      try {
        const result = await queryDeepSeek(prompt, historyKey, modelChoice);
        const formatted = formatResponse(result);
        const chunks = splitMessage(formatted);

        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      } catch (err) {
        console.error('[ERROR] DeepSeek query failed:', err);
        await interaction.editReply(`Error: ${err.message}`);
      }
    }
  });

  // Handle Mentions, Replies, DMs, and !ask / !reset commands
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !client.user) return;

    const isDM = message.channel.type === ChannelType.DM;
    const isMentioned = message.mentions.has(client.user.id);
    const rawContent = (message.content || '').trim();

    if (!rawContent && !isMentioned) return;

    const historyKey = getHistoryKey(message.channel.id, message.author.id);

    if (rawContent.toLowerCase() === '!reset') {
      conversationHistory.delete(historyKey);
      await message.reply('Conversation history cleared!');
      return;
    }

    let prompt = '';
    if (rawContent.toLowerCase().startsWith('!ask ')) {
      prompt = rawContent.slice(5).trim();
    } else if (isMentioned) {
      prompt = rawContent.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    } else if (isDM) {
      prompt = rawContent;
    } else {
      return;
    }

    if (!prompt) {
      await message.reply(
        'Hello! Mention me with a question, send me a DM, or use `/ask` to chat with DeepSeek!'
      );
      return;
    }

    try {
      if (message.channel.sendTyping) {
        await message.channel.sendTyping().catch(() => {});
      }
      const typingInterval = setInterval(() => {
        if (message.channel.sendTyping) {
          message.channel.sendTyping().catch(() => {});
        }
      }, 8000);

      let result;
      try {
        result = await queryDeepSeek(prompt, historyKey, getModel(message.channel.id));
      } finally {
        clearInterval(typingInterval);
      }

      const formatted = formatResponse(result);
      const chunks = splitMessage(formatted);

      await message.reply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
      }
    } catch (err) {
      console.error('[ERROR] DeepSeek message query failed:', err);
      await message.reply(`Error: ${err.message}`).catch(() => {});
    }
  });

  return client;
}

let fallbackTriggered = false;

async function triggerFallback(originalClient) {
  if (fallbackTriggered) return;
  fallbackTriggered = true;
  console.warn(
    '[WARN] Message Content Intent is not enabled in the Discord Developer Portal. Reconnecting with standard intents (Slash Commands, DMs, and @mentions will still work)...'
  );
  try {
    if (originalClient) {
      originalClient.destroy();
    }
  } catch (_) {}
  const fallbackClient = createBotClient(false);
  await fallbackClient.login(DISCORD_TOKEN);
}

async function startBot() {
  const client = createBotClient(true);

  client.on('shardDisconnect', (event) => {
    if (event && event.code === 4014) {
      triggerFallback(client);
    }
  });

  process.on('unhandledRejection', (err) => {
    const msg = String(err && (err.message || err.code || err));
    if (msg.includes('DisallowedIntents') || msg.includes('4014') || msg.includes('disallowed intents')) {
      triggerFallback(client);
    } else {
      console.error('[ERROR] Unhandled rejection:', err);
    }
  });

  try {
    await client.login(DISCORD_TOKEN);
  } catch (err) {
    const msg = String(err && (err.message || err.code || err));
    if (msg.includes('DisallowedIntents') || msg.includes('4014') || msg.includes('disallowed intents')) {
      await triggerFallback(client);
    } else {
      console.error('[FATAL] Failed to login to Discord:', err);
      process.exit(1);
    }
  }
}

startBot();
