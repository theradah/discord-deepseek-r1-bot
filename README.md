# Discord DeepSeek R1 Bot

A lightweight Node.js Discord bot powered by **DeepSeek R1** (`deepseek-reasoner`) and **DeepSeek V3** (`deepseek-chat`).

## Features
- **Slash Commands**:
  - `/ask <prompt> [model]` — Ask DeepSeek R1 or V3 a question
  - `/model <name>` — Switch the default model for the channel (`deepseek-reasoner` or `deepseek-chat`)
  - `/reset` — Clear your conversation history in the current channel
- **Mentions, DMs & Prefix Commands**:
  - Mention the bot (`@BotName your question`), DM the bot directly, or use `!ask your question` and `!reset`
- **Automatic Intent Fallback**:
  - Works even if the privileged `Message Content Intent` is not toggled on in the Discord Developer Portal
- **Long Response Splitting**:
  - Automatically splits responses longer than 2,000 characters into multiple Discord messages

## Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `DISCORD_TOKEN` | Your Discord Bot Token (from the Discord Developer Portal) | *(Required)* |
| `DEEPSEEK_API_KEY` | Your DeepSeek API Key | *(Required)* |
| `DEEPSEEK_BASE_URL` | DeepSeek API Base URL | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Default model (`deepseek-reasoner` or `deepseek-chat`) | `deepseek-reasoner` |

## Deployment
- **Branch**: `main`
- **Entry File**: `index.js`
- **Start Command**: `node index.js` (or `npm start`)
