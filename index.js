require('dotenv').config();
const vm = require('vm');
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
  'You are Ruth, a helpful, concise, and intelligent AI research assistant on Discord running directly on the official DeepSeek API (api.deepseek.com). You are a DeepSeek model created by DeepSeek (never claim to be Claude or Anthropic). You have access to live tools: web_search, search_papers (arXiv & Semantic Scholar), read_url (webpages & arXiv PDFs), and run_code_sandbox (isolated Python 3 & JavaScript sandbox). Use them proactively whenever users ask about research papers, current facts, URLs, calculations, or code execution.';

function getSystemPrompt() {
  const nowStr = new Date().toISOString().split('T')[0];
  return (
    `${BASE_SYSTEM_PROMPT}\n` +
    `Today's real current date is ${nowStr} (year 2026). Dates in 2025 and 2026 on websites and papers are real, current dates—not a simulation.\n` +
    `Multi-user chat rules: Each user message begins with a header like "[Message from DisplayName (@username, ID: ...)]" (and optionally "[Replying to ...]" or "[Attached File: ...]"). Use this header to differentiate between users, know who sent each message in the conversation history, and refer to users accurately. Do not repeat the "[Message from ...]" tag in your own response.`
  );
}

const MAX_HISTORY_TURNS = 15;
const DISCORD_MAX_LEN = 1900;

if (!DISCORD_TOKEN) {
  console.error('[ERROR] Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}
if (!DEEPSEEK_API_KEY) {
  console.error('[ERROR] Missing DEEPSEEK_API_KEY environment variable.');
  process.exit(1);
}

// Per-channel conversation history (shared across users with speaker tags) and selected model
const conversationHistory = new Map();
const channelModels = new Map();

function getHistoryKey(channelId) {
  return `${channelId}`;
}

function formatUserPrompt(user, member, rawPrompt, replyContext = '', attachmentContext = '') {
  const username = (user && user.username) || 'unknown';
  const displayName =
    (member && member.displayName) ||
    (user && (user.globalName || user.username)) ||
    username;
  const userId = (user && user.id) || 'unknown';
  const speakerLabel =
    displayName !== username
      ? `${displayName} (@${username}, ID: ${userId})`
      : `@${username} (ID: ${userId})`;
  const replyLine = replyContext ? `\n[Replying to ${replyContext}]` : '';
  const attachBlock = attachmentContext ? `\n\n${attachmentContext}` : '';
  return `[Message from ${speakerLabel}]${replyLine}:\n${rawPrompt}${attachBlock}`;
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

// --- Helper: HTML Entity Decoder ---
function decodeHtmlEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// --- Tool 1: Live Web Search ---
async function performWebSearch(query) {
  const searchTargets = [
    `https://r.jina.ai/https://search.yahoo.com/search?p=${encodeURIComponent(query)}`,
    `https://r.jina.ai/https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    `https://s.jina.ai/${encodeURIComponent(query)}`,
  ];

  for (const target of searchTargets) {
    try {
      const res = await fetch(target, {
        headers: {
          Accept: 'text/plain',
          'X-Retain-Images': 'none',
          'User-Agent': 'Discord-DeepSeek-Bot/1.0',
        },
      });
      if (res.ok) {
        const text = (await res.text()).trim();
        const isBotChallenge =
          text.includes('Unfortunately, bots use DuckDuckGo') ||
          text.includes('AuthenticationRequiredError') ||
          text.startsWith('{"data":null');
        if (text && text.length > 120 && !isBotChallenge) {
          return text.slice(0, 10000);
        }
      }
    } catch (_) {}
  }

  return `Search engine blocked datacenter query for "${query}". Try search_papers for academic papers or read_url directly on a known website URL.`;
}

// --- Tool 2: Academic Paper Search (arXiv + Semantic Scholar) ---
async function searchAcademicPapers(query, maxResults = 6) {
  const limit = Math.min(Math.max(Number(maxResults) || 6, 1), 10);
  const sections = [];

  // 1. Semantic Scholar Graph API
  const s2Promise = (async () => {
    try {
      const s2Url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
        query
      )}&limit=${limit}&fields=title,authors,year,citationCount,abstract,url,externalIds,openAccessPdf`;
      const res = await fetch(s2Url, {
        headers: { 'User-Agent': 'Discord-DeepSeek-ResearchBot/1.0' },
      });
      if (!res.ok) return '';
      const data = await res.json();
      if (!data.data || data.data.length === 0) return '';

      return (
        '=== Semantic Scholar Results ===\n' +
        data.data
          .map((p, idx) => {
            const authors = (p.authors || []).map((a) => a.name).join(', ') || 'Unknown';
            const arxivId = p.externalIds && p.externalIds.ArXiv ? `arXiv:${p.externalIds.ArXiv}` : '';
            const pdfUrl =
              (p.openAccessPdf && p.openAccessPdf.url) ||
              (p.externalIds && p.externalIds.ArXiv
                ? `https://arxiv.org/pdf/${p.externalIds.ArXiv}.pdf`
                : p.url || '');
            const abstract = (p.abstract || 'No abstract available.').slice(0, 600);
            return `[S2-${idx + 1}] "${p.title}" (${p.year || 'n.d.'}) ${arxivId}\nAuthors: ${authors}\nCitations: ${
              p.citationCount ?? 0
            } | URL: ${pdfUrl}\nAbstract: ${abstract}`;
          })
          .join('\n\n')
      );
    } catch (_) {
      return '';
    }
  })();

  // 2. Official arXiv API
  const arxivPromise = (async () => {
    try {
      const arxivUrl = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
        query
      )}&start=0&max_results=${limit}`;
      const res = await fetch(arxivUrl, {
        headers: { 'User-Agent': 'Discord-DeepSeek-ResearchBot/1.0' },
      });
      if (!res.ok) return '';
      const xml = await res.text();
      const entries = xml.split('<entry>').slice(1);
      if (entries.length === 0) return '';

      const parsed = entries.map((entry, idx) => {
        const getTag = (tag) => {
          const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
          return m ? decodeHtmlEntities(m[1].replace(/\s+/g, ' ').trim()) : '';
        };
        const title = getTag('title');
        const summary = getTag('summary').slice(0, 650);
        const published = getTag('published').slice(0, 10);
        const idUrl = getTag('id');
        const authorMatches = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((m) =>
          m[1].trim()
        );
        const authors = authorMatches.join(', ') || 'Unknown';
        return `[arXiv-${idx + 1}] "${title}" (Published: ${published})\nAuthors: ${authors}\nLink: ${idUrl}\nAbstract: ${summary}`;
      });

      return '=== arXiv Results ===\n' + parsed.join('\n\n');
    } catch (_) {
      return '';
    }
  })();

  const [s2Out, arxivOut] = await Promise.all([s2Promise, arxivPromise]);
  if (s2Out) sections.push(s2Out);
  if (arxivOut) sections.push(arxivOut);

  if (sections.length === 0) {
    return `No academic papers found on Semantic Scholar or arXiv for "${query}". Try broader keywords or use web_search.`;
  }
  return sections.join('\n\n').slice(0, 12000);
}

// --- Tool 3: Webpage & Paper PDF Reader ---
async function readWebPage(targetUrl) {
  try {
    let urlToRead = (targetUrl || '').trim();
    // If given an arXiv abstract/pdf URL, ar5iv HTML or Jina PDF reader gives full paper text
    const arxivMatch = urlToRead.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]+\.[0-9]+(?:v\d+)?)/i);
    if (arxivMatch) {
      const arxivId = arxivMatch[1];
      const ar5ivRes = await fetch(`https://r.jina.ai/https://ar5iv.labs.arxiv.org/html/${arxivId}`, {
        headers: { Accept: 'text/plain', 'User-Agent': 'Discord-DeepSeek-Bot/1.0' },
      }).catch(() => null);
      if (ar5ivRes && ar5ivRes.ok) {
        const text = await ar5ivRes.text();
        if (text && text.length > 500) {
          return text.slice(0, 14000);
        }
      }
    }

    const jinaUrl = `https://r.jina.ai/${urlToRead}`;
    const res = await fetch(jinaUrl, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'Discord-DeepSeek-Bot/1.0',
      },
    });
    if (res.ok) {
      const text = await res.text();
      return text.slice(0, 13000);
    }

    const rawRes = await fetch(urlToRead, {
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

// --- Tool 4: Isolated Code Execution Sandbox (Python 3 & JavaScript) ---
async function executeCodeSandbox(language, code) {
  const lang = (language || 'python').toLowerCase().trim();
  const cleanCode = (code || '').trim();
  if (!cleanCode) return 'Error: No code provided to execute.';

  // 1. Remote isolated container sandbox via Wandbox API (supports Python 3, Node.js, C++, Bash)
  const wandboxCompilers = {
    python: 'cpython-3.12.7',
    py: 'cpython-3.12.7',
    javascript: 'nodejs-20.17.0',
    js: 'nodejs-20.17.0',
    cpp: 'gcc-13.2.0',
    'c++': 'gcc-13.2.0',
    bash: 'bash',
    sh: 'bash',
  };

  // Try Piston public remote sandbox first
  const pistonLangMap = {
    python: { language: 'python', version: '3.10.0' },
    py: { language: 'python', version: '3.10.0' },
    javascript: { language: 'javascript', version: '18.15.0' },
    js: { language: 'javascript', version: '18.15.0' },
    cpp: { language: 'c++', version: '10.2.0' },
    'c++': { language: 'c++', version: '10.2.0' },
    bash: { language: 'bash', version: '5.2.0' },
  };

  if (pistonLangMap[lang]) {
    try {
      const pRes = await fetch('https://emkc.org/api/v2/piston/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: pistonLangMap[lang].language,
          version: pistonLangMap[lang].version,
          files: [{ content: cleanCode }],
          run_timeout: 8000,
        }),
      });
      if (pRes.ok) {
        const pData = await pRes.json();
        if (pData && pData.run) {
          const stdout = (pData.run.stdout || '').trim();
          const stderr = (pData.run.stderr || '').trim();
          const codeExit = pData.run.code ?? 0;
          return (
            `[Sandbox (${lang}) | Exit Code: ${codeExit}]\n` +
            (stdout ? `STDOUT:\n${stdout}\n` : '') +
            (stderr ? `STDERR:\n${stderr}\n` : '') +
            (!stdout && !stderr ? '(Executed with no output)' : '')
          ).slice(0, 6000);
        }
      }
    } catch (_) {}
  }

  // 2. Fallback to Wandbox isolated remote container sandbox
  const compiler = wandboxCompilers[lang] || (lang.includes('py') ? 'cpython-3.12.7' : null);
  if (compiler) {
    try {
      const wRes = await fetch('https://wandbox.org/api/compile.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          compiler,
          code: cleanCode,
        }),
      });
      if (wRes.ok) {
        const wData = await wRes.json();
        const stdout = (wData.program_output || wData.program_message || '').trim();
        const stderr = (wData.compiler_error || wData.program_error || '').trim();
        const status = wData.status ?? 0;
        return (
          `[Sandbox (${compiler}) | Exit Status: ${status}]\n` +
          (stdout ? `OUTPUT:\n${stdout}\n` : '') +
          (stderr ? `ERRORS:\n${stderr}\n` : '') +
          (!stdout && !stderr ? '(Executed with no output)' : '')
        ).slice(0, 6000);
      }
    } catch (_) {}
  }

  // 3. Local zero-privilege Node VM fallback for JavaScript
  if (lang === 'javascript' || lang === 'js') {
    const logs = [];
    const sandboxConsole = {
      log: (...args) => logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
      error: (...args) => logs.push('[ERR] ' + args.map(String).join(' ')),
      warn: (...args) => logs.push('[WARN] ' + args.map(String).join(' ')),
    };
    const context = vm.createContext({
      console: sandboxConsole,
      Math,
      Date,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      Promise,
    });
    try {
      const result = vm.runInContext(cleanCode, context, { timeout: 4000 });
      if (result !== undefined) {
        logs.push(`Return value: ${typeof result === 'object' ? JSON.stringify(result) : String(result)}`);
      }
      return `[Local JS VM Sandbox]\n${logs.join('\n') || '(Executed with no output)'}`.slice(0, 6000);
    } catch (err) {
      return `[Local JS VM Sandbox Error]\n${err.message}`;
    }
  }

  return `Could not execute ${lang} sandbox right now (remote sandbox service unreachable).`;
}

// --- Discord File Attachment Reader ---
async function extractAttachmentContext(message) {
  const attachments = [];
  if (message.attachments && message.attachments.size > 0) {
    for (const att of message.attachments.values()) {
      attachments.push(att);
    }
  }

  if (attachments.length === 0) return '';

  const extractedBlocks = [];
  const textExtensions = /\.(txt|py|js|ts|jsx|tsx|md|csv|json|tex|bib|yaml|yml|html|css|sh|rs|cpp|c|h|java|go|log|sql|r)$/i;

  for (const att of attachments.slice(0, 3)) {
    const name = att.name || 'attachment';
    const url = att.url;
    const contentType = (att.contentType || '').toLowerCase();

    try {
      if (name.toLowerCase().endsWith('.pdf') || contentType.includes('pdf')) {
        const pdfText = await readWebPage(url);
        extractedBlocks.push(`[Attached PDF: ${name}]\n${pdfText.slice(0, 10000)}`);
      } else if (
        textExtensions.test(name) ||
        contentType.startsWith('text/') ||
        contentType.includes('json')
      ) {
        const res = await fetch(url);
        if (res.ok) {
          const text = await res.text();
          extractedBlocks.push(`[Attached File: ${name}]\n\`\`\`\n${text.slice(0, 10000)}\n\`\`\``);
        }
      } else {
        extractedBlocks.push(`[Attached File: ${name} (${contentType || 'binary'}, URL: ${url})]`);
      }
    } catch (err) {
      extractedBlocks.push(`[Attached File: ${name} - Could not read: ${err.message}]`);
    }
  }

  return extractedBlocks.join('\n\n');
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the live web for current events, facts, companies, benchmarks, or any general topic.',
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
      name: 'search_papers',
      description:
        'Search arXiv and Semantic Scholar for academic research papers, preprints, authors, citation counts, abstracts, and PDF links.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Paper title, keywords, or author name to search on arXiv and Semantic Scholar.',
          },
          max_results: {
            type: 'integer',
            description: 'Maximum number of papers to return (default 6, max 10).',
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
        'Fetch and read the full text content of a webpage URL, arXiv paper link (abs or pdf), or online PDF.',
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
  {
    type: 'function',
    function: {
      name: 'run_code_sandbox',
      description:
        'Execute code inside an isolated sandbox container (supports python, javascript, cpp, bash) and return stdout/stderr. Use this to run simulations, verify math/statistics, test algorithms, or run user code.',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'javascript', 'cpp', 'bash'],
            description: 'Programming language to execute in the sandbox.',
          },
          code: {
            type: 'string',
            description: 'Complete source code to execute. Print outputs to stdout.',
          },
        },
        required: ['language', 'code'],
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

async function queryDeepSeek(prompt, historyKey, modelOverride, effortOverride, skipHistorySave = false) {
  const history = skipHistorySave ? [] : conversationHistory.get(historyKey) || [];
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
      } else if (fnName === 'search_papers') {
        console.log(`[TOOL] search_papers: "${args.query}"`);
        toolOutput = await searchAcademicPapers(args.query || prompt, args.max_results);
      } else if (fnName === 'read_url') {
        console.log(`[TOOL] read_url: "${args.url}"`);
        toolOutput = await readWebPage(args.url || '');
      } else if (fnName === 'run_code_sandbox') {
        console.log(`[TOOL] run_code_sandbox (${args.language})`);
        toolOutput = await executeCodeSandbox(args.language || 'python', args.code || '');
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

  if (!skipHistorySave) {
    appendHistory(historyKey, prompt, answer);
  }

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
    .setDescription('Ask DeepSeek a question (with web search, arXiv search, and code sandbox)')
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
    .setName('papers')
    .setDescription('Search arXiv & Semantic Scholar for research papers and summarize findings')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Paper topic, title, or author').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('run')
    .setDescription('Run code directly in an isolated sandbox (Python 3, JavaScript, C++, Bash)')
    .addStringOption((opt) =>
      opt
        .setName('language')
        .setDescription('Programming language')
        .setRequired(true)
        .addChoices(
          { name: 'Python 3', value: 'python' },
          { name: 'JavaScript (Node.js)', value: 'javascript' },
          { name: 'C++ (GCC)', value: 'cpp' },
          { name: 'Bash', value: 'bash' }
        )
    )
    .addStringOption((opt) =>
      opt.setName('code').setDescription('Code snippet to execute').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('summarize')
    .setDescription('Summarize the recent discussion in this Discord channel')
    .addIntegerOption((opt) =>
      opt
        .setName('messages')
        .setDescription('Number of recent messages to summarize (default: 30, max: 100)')
        .setRequired(false)
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
    .setDescription('Clear the conversation history with DeepSeek in this channel'),
].map((cmd) => cmd.toJSON());

async function registerSlashCommands(clientId) {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(clientId), { body: slashCommands });
    console.log('[INFO] Slash commands (/ask, /papers, /run, /summarize, /model, /reset) registered.');
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
    console.log('[TOOLS] Active: web_search, search_papers (arXiv/S2), read_url, run_code_sandbox');
    await registerSlashCommands(readyClient.user.id);
  });

  // Handle Slash Commands
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const historyKey = getHistoryKey(interaction.channelId);

    if (interaction.commandName === 'reset') {
      conversationHistory.delete(historyKey);
      await interaction.reply({
        content: 'Conversation history cleared for this channel!',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === 'model') {
      const selectedModel = interaction.options.getString('name', true);
      channelModels.set(interaction.channelId, selectedModel);
      await interaction.reply(`Active model for this channel set to **${selectedModel}**.`);
      return;
    }

    if (interaction.commandName === 'run') {
      const language = interaction.options.getString('language', true);
      const code = interaction.options.getString('code', true);
      await interaction.deferReply();
      try {
        const output = await executeCodeSandbox(language, code);
        const formatted = `**Code:**\n\`\`\`${language}\n${code.slice(0, 800)}\n\`\`\`\n**Output:**\n\`\`\`text\n${output}\n\`\`\``;
        const chunks = splitMessage(formatted);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      } catch (err) {
        await interaction.editReply(`Sandbox error: ${err.message}`);
      }
      return;
    }

    if (interaction.commandName === 'papers') {
      const query = interaction.options.getString('query', true);
      await interaction.deferReply();
      try {
        const rawPapers = await searchAcademicPapers(query, 6);
        const synthPrompt = formatUserPrompt(
          interaction.user,
          interaction.member,
          `I searched arXiv & Semantic Scholar for "${query}". Here are the raw paper results:\n\n${rawPapers}\n\nPlease organize and summarize the most relevant papers found (with titles, authors, year, citations, key findings, and direct links).`
        );
        const result = await queryDeepSeek(synthPrompt, historyKey, getModel(interaction.channelId), 'low');
        const chunks = splitMessage(result.answer);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      } catch (err) {
        await interaction.editReply(`Paper search error: ${err.message}`);
      }
      return;
    }

    if (interaction.commandName === 'summarize') {
      const count = Math.min(Math.max(interaction.options.getInteger('messages') || 30, 5), 100);
      await interaction.deferReply();
      try {
        const fetched = await interaction.channel.messages.fetch({ limit: count });
        const sorted = [...fetched.values()].reverse();
        const transcript = sorted
          .filter((m) => m.content || (m.attachments && m.attachments.size > 0))
          .map((m) => {
            const name =
              (m.member && m.member.displayName) ||
              m.author.globalName ||
              m.author.username;
            const attNote =
              m.attachments && m.attachments.size > 0
                ? ` [Attachments: ${[...m.attachments.values()].map((a) => a.name).join(', ')}]`
                : '';
            return `[${name} (@${m.author.username})]: ${(m.content || '').slice(0, 500)}${attNote}`;
          })
          .join('\n');

        const sumPrompt =
          `Please provide a clear, structured summary of the following ${sorted.length} messages from this Discord research channel. ` +
          `Highlight: (1) Main topics discussed & who brought them up, (2) Key conclusions or open questions, and (3) Any papers, tools, or links mentioned.\n\n` +
          `--- CHANNEL TRANSCRIPT ---\n${transcript.slice(0, 24000)}`;

        const result = await queryDeepSeek(
          sumPrompt,
          historyKey,
          getModel(interaction.channelId),
          'low',
          true
        );
        const chunks = splitMessage(result.answer);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      } catch (err) {
        await interaction.editReply(`Could not summarize channel: ${err.message}`);
      }
      return;
    }

    if (interaction.commandName === 'ask') {
      const rawPrompt = interaction.options.getString('prompt', true);
      const attributedPrompt = formatUserPrompt(
        interaction.user,
        interaction.member,
        rawPrompt
      );
      const modelChoice =
        interaction.options.getString('model', false) || getModel(interaction.channelId);
      const thinkingChoice = interaction.options.getString('thinking', false) || undefined;

      await interaction.deferReply();
      try {
        const result = await queryDeepSeek(
          attributedPrompt,
          historyKey,
          modelChoice,
          thinkingChoice
        );
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

  // Handle Mentions, Replies, DMs, Attachments, and !ask / !reset commands
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !client.user) return;

    const isDM = message.channel.type === ChannelType.DM;
    const isMentioned = message.mentions.has(client.user.id);
    const rawContent = (message.content || '').trim();

    let referencedMsg = null;
    let isReplyToBot = false;
    if (message.reference && message.reference.messageId) {
      referencedMsg = await message.fetchReference().catch(() => null);
      if (referencedMsg && referencedMsg.author && referencedMsg.author.id === client.user.id) {
        isReplyToBot = true;
      }
    }

    const hasAttachments = message.attachments && message.attachments.size > 0;
    if (!rawContent && !isMentioned && !isReplyToBot && !(isDM && hasAttachments)) return;

    const historyKey = getHistoryKey(message.channel.id);

    if (rawContent.toLowerCase() === '!reset') {
      conversationHistory.delete(historyKey);
      await message.reply('Conversation history cleared for this channel!');
      return;
    }

    let prompt = '';
    if (rawContent.toLowerCase().startsWith('!ask ')) {
      prompt = rawContent.slice(5).trim();
    } else if (isMentioned || isReplyToBot) {
      prompt = rawContent.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    } else if (isDM) {
      prompt = rawContent;
    } else {
      return;
    }

    // Extract text from any files attached to the current message or the referenced message
    let attachmentContext = await extractAttachmentContext(message);
    if (referencedMsg && referencedMsg.attachments && referencedMsg.attachments.size > 0) {
      const refAttachments = await extractAttachmentContext(referencedMsg);
      if (refAttachments) {
        attachmentContext = attachmentContext
          ? `${attachmentContext}\n\n${refAttachments}`
          : refAttachments;
      }
    }

    if (!prompt && attachmentContext) {
      prompt = 'Please analyze and summarize the attached file(s).';
    }

    if (!prompt) {
      await message.reply(
        'Hello! Mention me with a question, attach a file/paper, reply to me, or use `/ask`, `/papers`, `/run`, or `/summarize`!'
      );
      return;
    }

    // Replace raw <@userId> mentions of other users with readable names
    prompt = prompt.replace(/<@!?(\d+)>/g, (full, id) => {
      const mentionedMember = message.mentions.members && message.mentions.members.get(id);
      const mentionedUser = message.mentions.users && message.mentions.users.get(id);
      if (mentionedMember) {
        return `@${mentionedMember.displayName} (@${mentionedMember.user.username})`;
      }
      if (mentionedUser) {
        return `@${mentionedUser.globalName || mentionedUser.username} (@${mentionedUser.username})`;
      }
      return full;
    });

    let replyContext = '';
    if (referencedMsg && referencedMsg.author) {
      const refUser = referencedMsg.author;
      const refName =
        (referencedMsg.member && referencedMsg.member.displayName) ||
        refUser.globalName ||
        refUser.username;
      const refSnippet = (referencedMsg.content || '').trim().slice(0, 350);
      if (refSnippet) {
        replyContext = `${refName} (@${refUser.username}): "${refSnippet}"`;
      }
    }

    const attributedPrompt = formatUserPrompt(
      message.author,
      message.member,
      prompt,
      replyContext,
      attachmentContext
    );

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
        result = await queryDeepSeek(attributedPrompt, historyKey, getModel(message.channel.id));
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
