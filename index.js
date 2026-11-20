require('dotenv').config();
const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
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

function normalizeModel(rawModel) {
  const m = (rawModel || '').trim();
  if (!m || m === 'deepseek-reasoner') return 'deepseek-flash';
  if (m === 'deepseek-chat') return 'deepseek-flash';
  return m;
}

const DEFAULT_MODEL = normalizeModel(process.env.DEEPSEEK_MODEL || 'deepseek-flash');
const DEFAULT_REASONING_EFFORT = (
  process.env.DEEPSEEK_REASONING_EFFORT ||
  (process.env.DEEPSEEK_MODEL === 'deepseek-chat' ? 'none' : 'high')
).trim();
const BASE_SYSTEM_PROMPT =
  (process.env.SYSTEM_PROMPT || '').trim() ||
  'You are Ruth, a helpful, concise, and intelligent AI assistant on Discord running directly on the official DeepSeek API (api.deepseek.com). You are a DeepSeek model created by DeepSeek (never claim to be Claude or Anthropic). You have access to live web_search and read_url tools—use them whenever the user asks you to Google, search the web, verify current facts, or check a website.';

function getSystemPrompt() {
  const nowStr = new Date().toISOString().split('T')[0];
  return `${BASE_SYSTEM_PROMPT}\nToday's real current date is ${nowStr} (year 2026). Dates in 2025 and 2026 on websites are real, current dates—not a simulation.`;
}

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

// --- Web Search & URL Reader Tools (Zero API Key Required) ---
function decodeHtmlEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function performWebSearch(query) {
  // 1. Try Jina Web Search reader first (works reliably from cloud datacenter IPs)
  try {
    const jinaSearchUrl = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const jinaRes = await fetch(jinaSearchUrl, {
      headers: {
        Accept: 'text/plain',
        'X-Retain-Images': 'none',
        'User-Agent': 'Discord-DeepSeek-Bot/1.0',
      },
    });
    if (jinaRes.ok) {
      const text = (await jinaRes.text()).trim();
      if (text && text.length > 80 && !text.startsWith('{"data":null')) {
        return text.slice(0, 10000);
      }
    }
  } catch (_) {}

  // 2. Try DuckDuckGo HTML search with tolerant regexes
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    const html = await res.text();

    const results = [];
    const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    const links = [];
    let m;
    while ((m = linkRegex.exec(html)) !== null && links.length < 8) {
      let href = m[1];
      const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
      const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '').trim());
      links.push({ title, url: href });
    }

    const snippets = [];
    while ((m = snippetRegex.exec(html)) !== null && snippets.length < 8) {
      snippets.push(decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim()));
    }

    for (let i = 0; i < links.length; i++) {
      if (links[i].title && links[i].url) {
        results.push({
          title: links[i].title,
          url: links[i].url,
          snippet: snippets[i] || '',
        });
      }
    }

    if (results.length > 0) {
      return results
        .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`)
        .join('\n\n');
    }
  } catch (_) {}

  // 3. Fallback: Read DuckDuckGo Lite via Jina Reader
  try {
    const ddgJina = `https://r.jina.ai/https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const res = await fetch(ddgJina, {
      headers: { Accept: 'text/plain', 'User-Agent': 'Discord-DeepSeek-Bot/1.0' },
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text.length > 50) return text.slice(0, 10000);
    }
  } catch (err) {
    return `Web search error: ${err.message}`;
  }

  return `No search results found for "${query}". Try using read_url directly on a known website URL.`;
}

async function readWebPage(targetUrl) {
  try {
    const jinaUrl = `https://r.jina.ai/${targetUrl}`;
    const res = await fetch(jinaUrl, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'Discord-DeepSeek-Bot/1.0',
      },
    });
    if (res.ok) {
      const text = await res.text();
      return text.slice(0, 12000);
    }

    const rawRes = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
    });
    const html = await rawRes.text();
    const cleaned = decodeHtmlEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
    return cleaned.slice(0, 10000) || 'Could not extract readable text from page.';
  } catch (err) {
    return `Failed to read URL (${targetUrl}): ${err.message}`;
  }
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the live web (via DuckDuckGo) for current events, facts, companies, research papers, or any topic the user asks to Google or look up.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query string to look up on the web.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description:
        'Fetch and read the text content of a specific webpage URL (for example, a URL returned by web_search or shared by the user).',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full http:// or https:// URL to read.',
          },
        },
        required: ['url'],
      },
    },
  },
];

// --- DeepSeek API Client ---
async function callDeepSeekEndpoint(payload) {
  const endpoint = `${DEEPSEEK_BASE_URL}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`DeepSeek API error (${response.status}): ${errText || response.statusText}`);
  }

  return response.json();
}

async function queryDeepSeek(prompt, historyKey, modelOverride, effortOverride) {
  const history = conversationHistory.get(historyKey) || [];
  const model = normalizeModel(modelOverride || DEFAULT_MODEL);
  const reasoningEffort = effortOverride || DEFAULT_REASONING_EFFORT;

  // Build strictly alternating messages
  const messages = [{ role: 'system', content: getSystemPrompt() }];
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

  let combinedReasoning = '';
  let choice = null;
  const MAX_TOOL_STEPS = 7;

  for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
    const isFinalStep = step === MAX_TOOL_STEPS;
    const payload = {
      model,
      messages,
      reasoning_effort: reasoningEffort,
      stream: false,
    };
    if (!isFinalStep) {
      payload.tools = TOOLS;
    }

    let data;
    try {
      data = await callDeepSeekEndpoint(payload);
    } catch (err) {
      // Fallback without tools if model/endpoint rejects tool definitions
      if (step === 0 && String(err.message).toLowerCase().includes('tool')) {
        delete payload.tools;
        data = await callDeepSeekEndpoint(payload);
      } else {
        throw err;
      }
    }

    choice = data.choices && data.choices[0] && data.choices[0].message;
    if (!choice) {
      throw new Error('Empty response received from DeepSeek API.');
    }

    if (choice.reasoning_content) {
      combinedReasoning += (combinedReasoning ? '\n' : '') + choice.reasoning_content.trim();
    }

    if (!choice.tool_calls || choice.tool_calls.length === 0) {
      break;
    }

    // Preserve reasoning_content during tool call sub-turns as required by DeepSeek Thinking Mode
    messages.push({
      role: 'assistant',
      content: choice.content || '',
      reasoning_content: choice.reasoning_content || '',
      tool_calls: choice.tool_calls,
    });

    for (const toolCall of choice.tool_calls) {
      const fnName = toolCall.function && toolCall.function.name;
      let args = {};
      try {
        args = JSON.parse((toolCall.function && toolCall.function.arguments) || '{}');
      } catch (_) {}

      let toolOutput = '';
      if (fnName === 'web_search') {
        console.log(`[TOOL] web_search: "${args.query}"`);
        toolOutput = await performWebSearch(args.query || prompt);
      } else if (fnName === 'read_url') {
        console.log(`[TOOL] read_url: "${args.url}"`);
        toolOutput = await readWebPage(args.url || '');
      } else {
        toolOutput = `Unknown tool: ${fnName}`;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolOutput,
      });
    }
  }

  const answer = (choice && choice.content ? choice.content : '').trim() || '*(No response content)*';
  const reasoning = combinedReasoning.trim();

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
        .setDescription('Choose DeepSeek V4 model for this prompt')
        .setRequired(false)
        .addChoices(
          { name: 'DeepSeek V4.1 Flash (deepseek-flash)', value: 'deepseek-flash' },
          { name: 'DeepSeek V4 Pro (deepseek-v4-pro)', value: 'deepseek-v4-pro' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('thinking')
        .setDescription('Reasoning effort level (default: high)')
        .setRequired(false)
        .addChoices(
          { name: 'None (Fast / Non-thinking)', value: 'none' },
          { name: 'Low', value: 'low' },
          { name: 'High (Default)', value: 'high' },
          { name: 'Max', value: 'max' }
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
          { name: 'DeepSeek V4.1 Flash (deepseek-flash)', value: 'deepseek-flash' },
          { name: 'DeepSeek V4 Pro (deepseek-v4-pro)', value: 'deepseek-v4-pro' }
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

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[READY] Logged in as ${readyClient.user.tag}`);
    console.log(`[CONFIG] Base URL: ${DEEPSEEK_BASE_URL} | Default Model: ${DEFAULT_MODEL}`);
    console.log('[TOOLS] Live Web Search (web_search & read_url) active');
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
        flags: MessageFlags.Ephemeral,
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
      const thinkingChoice = interaction.options.getString('thinking', false) || undefined;

      await interaction.deferReply();
      try {
        const result = await queryDeepSeek(prompt, historyKey, modelChoice, thinkingChoice);
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
