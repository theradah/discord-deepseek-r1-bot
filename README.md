# Discord DeepSeek V4 Research Bot (Ruth)

A Node.js Discord research assistant powered by **DeepSeek V4.1 Flash** (`deepseek-flash`) and **DeepSeek V4 Pro** (`deepseek-v4-pro`).

## Features
- **Slash Commands**:
  - `/ask <prompt> [model] [thinking]` — Ask DeepSeek a question with autonomous access to web search, arXiv/Semantic Scholar search, URL/PDF reading, and code sandbox execution
  - `/papers <query>` — Search **arXiv** and **Semantic Scholar** directly for academic papers (returns titles, authors, year, citation counts, abstracts, and PDF links)
  - `/run <language> <code>` — Run **Python 3**, **JavaScript**, **C++**, or **Bash** snippets in an isolated code sandbox
  - `/summarize [messages]` — Summarize the last N messages (up to 100) in the current Discord channel
  - `/model <name>` — Switch the default model for the channel (`deepseek-flash` or `deepseek-v4-pro`)
  - `/reset` — Clear conversation history in the current channel
- **Autonomous Research Tools (Function Calling)**:
  - `search_papers` — Queries official arXiv API + Semantic Scholar Graph API
  - `web_search` — Live web search via Jina Reader / Yahoo / DuckDuckGo
  - `read_url` — Reads webpages, full arXiv papers (`ar5iv` / PDF), and online PDFs
  - `run_code_sandbox` — Executes Python 3, JavaScript, C++, or Bash in an isolated sandbox container
- **File Attachment Reader**:
  - Reads uploaded `.pdf`, `.py`, `.js`, `.ts`, `.md`, `.csv`, `.json`, `.tex`, `.bib`, `.txt`, and log files attached to Discord messages
- **Multi-User Attribution & Shared Channel Memory**:
  - Tracks who sent each message (`DisplayName (@username)`) and understands Discord replies and `@mentions`

## Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `DISCORD_TOKEN` | Your Discord Bot Token | *(Required)* |
| `DEEPSEEK_API_KEY` | Your DeepSeek API Key | *(Required)* |
| `DEEPSEEK_BASE_URL` | DeepSeek API Base URL | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Default model (`deepseek-flash` or `deepseek-v4-pro`) | `deepseek-flash` |
| `DEEPSEEK_REASONING_EFFORT` | Default thinking effort (`none`, `low`, `high`, `max`) | `high` |
