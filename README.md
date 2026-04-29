# Furet

Personal AI assistant with self-evolving capabilities. Discord bot + CLI, powered by a self-built agent loop on the Anthropic Messages API.

## Features

- **Self-built agent loop** — no SDK dependency, full control over the inference cycle
- **Multi-turn session** — standard message format with thinking + tool_use history
- **Token-based context management** — auto-trim history within budget, preserving tool call pairs
- **Memory system** — daily logs + long-term memory (MEMORY.md) with capacity limits + semantic recall (Gemini embedding)
- **Self-evolution** — can modify its own source code via `self_evolve` tool (delegates to a stronger model)
- **Discord integration** — mention/DM trigger, progressive tool progress display, slash commands
- **Scheduled tasks** — cron jobs + one-time reminders with auto-delivery to Discord channels
- **Daily journal** — auto-summarize sessions, rewrite diary, extract long-term facts
- **Google API** — Calendar, Gmail, Drive, Tasks integration
- **Skill system** — installable skill plugins from git repos

## Installation

### Prerequisites

- Node.js >= 24
- npm

### Steps

```bash
# 1. Clone the project
git clone <repo-url> ~/.furet && cd ~/.furet

# 2. Install (dependencies + global CLI + systemd service + workspace templates)
npx tsx bin/furet.ts install

# 3. Configure API keys and Discord token
vim .env

# 4. Configure model, Discord options, schedules, etc.
vim config.yaml
```

The install script will automatically:
- Run `npm install` to install dependencies
- Copy `config.example.yaml` → `config.yaml` and `.env.example` → `.env` (if not exist)
- Set up `workspace/` with templates (AGENT.md, SOUL.md, MEMORY.md, PEOPLE.md, JOURNAL.md)
- Run `npm link` to register the global `furet` command
- Create and enable a systemd service (`furet.service`)

## Starting & Managing

### Manual start

```bash
furet gateway
```

### Via systemd

```bash
sudo systemctl start furet     # start
sudo systemctl stop furet      # stop
sudo systemctl restart furet   # restart
sudo systemctl status furet    # check status
journalctl -u furet -f         # live logs
```

## Usage

### CLI Commands

| Command | Description |
|---------|------------|
| `furet gateway` | Start Discord bot + background services |
| `furet install` | Install dependencies + register systemd service |
| `furet` | Interactive CLI mode |

### Discord Slash Commands

| Command | Description |
|---------|------------|
| `/new` | Archive current session and start fresh |
| `/status` | Show bot status (model, token usage, sessions) |
| `/restart` | Restart the gateway (owner only) |
| `/model` | Switch AI model (owner only) |
| `/google-auth` | Google OAuth setup (owner only) |
| `/task` | List Google Tasks |

## Configuration

### .env (sensitive)

```
LLM_API_KEY=                # Anthropic API key
LLM_BASE_URL=http://localhost:8317/v1  # API endpoint
DISCORD_TOKEN=              # Discord bot token
GOOGLE_CLIENT_ID=           # Google OAuth client ID
GOOGLE_CLIENT_SECRET=       # Google OAuth client secret
```

### config.yaml (non-sensitive)

```yaml
llm:
  api_key: "${LLM_API_KEY}"
  base_url: "${LLM_BASE_URL}"
  currentModel: "claude-sonnet-4-6"
  codingModel: "claude-opus-4-6"      # model for self_evolve
  maxContextTokens: 150000            # token budget for context
  memoryCharLimit: 3000               # MEMORY.md character limit
  modelList:
    - claude-opus-4-6
    - claude-sonnet-4-6
    - claude-haiku-4-5-20251001

discord:
  enabled: true
  token: "${DISCORD_TOKEN}"
  allowed_channels: []
  allowed_guilds: []
  owner_id: "your-discord-user-id"

journal:
  enabled: true
  hour: 23
  minute: 59
```

### Google API

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable: Calendar API, Gmail API, Drive API, Tasks API
3. Create OAuth 2.0 Client ID (Desktop app type)
4. Add credentials to `.env`
5. Restart bot, then use `/google-auth` in Discord to authorize

### Workspace Structure

`workspace/` is created by `furet install` and contains all runtime data:

```
workspace/
├── AGENT.md         # System instructions (behavior, tools, boundaries)
├── SOUL.md          # Persona (name, personality, tone)
├── MEMORY.md        # Long-term memory (auto-managed, has capacity limit)
├── PEOPLE.md        # People directory
├── JOURNAL.md       # Memory hook, session summarize, daily journal prompts
├── config/          # Structured data (crons, reminders, google token)
├── memory/          # Daily memory files + vectors.json
├── sessions/        # Conversation sessions + archive/
└── skills/          # Installed skill plugins
```

All `.md` files use XML tags (e.g. `<agent-instructions>`, `<persona>`, `<memory>`) for clear section boundaries in the system prompt. Customize them to change behavior, personality, and prompts.

## Architecture

See [DESIGN.md](DESIGN.md) for full architecture documentation.

## Uninstall

```bash
sudo systemctl stop furet
sudo systemctl disable furet
sudo rm /etc/systemd/system/furet.service
sudo systemctl daemon-reload
npm unlink -g furet
rm -rf ~/.furet
```
