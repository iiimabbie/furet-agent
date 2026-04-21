# Furet

Personal assistant Discord bot powered by `@mariozechner/pi-coding-agent`.

## Prerequisites

- Node.js >= 24
- npm

## Quick Start

```bash
git clone <repo-url> && cd furet

# install dependencies, register CLI, setup systemd service
npx tsx bin/furet.ts install
```

Install will:
1. `npm install`
2. Copy `config.example.yaml` → `config.yaml` and `.env.example` → `.env` (if not exist)
3. Set up `workspace/` with templates (AGENT.md, FURET.md, SOUL.md, MEMORY.md, PEOPLE.md, JOURNAL.md)
4. `npm link` to register the global `furet` command
5. Generate and enable a systemd service (`furet.service`)

After install, fill in your settings:

```bash
vim .env          # API keys, Discord token, Google OAuth credentials
vim config.yaml   # model, Discord options, journal, skills
```

Then start:

```bash
furet gateway
```

## Commands

| Command | Description |
|---------|------------|
| `furet gateway` | Start Discord bot |
| `furet install` | Install dependencies + register systemd service |
| `furet` | Interactive CLI mode |

## Discord Slash Commands

| Command | Description |
|---------|------------|
| `/new` | Archive session and start fresh |
| `/status` | Show bot status (model, tokens, cost, sessions) |
| `/restart` | Restart the gateway (owner only) |
| `/model` | Switch AI model with autocomplete (owner only) |
| `/google-auth` | Google OAuth setup (owner only) |

## Google API Setup

Furet integrates with Google Calendar, Gmail, Drive, and Tasks.

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable: Calendar API, Gmail API, Drive API, Tasks API
3. Create OAuth 2.0 Client ID (Desktop app type)
4. Add credentials to `.env`:
   ```
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```
5. Restart bot, then use `/google-auth` in Discord to authorize

## Workspace Structure

`workspace/` is created by `furet install` and contains all runtime data:

```
workspace/
├── AGENT.md         # System instructions (behavior, tools, boundaries)
├── FURET.md         # Core long-lived instruction layer (loaded as primary system layer)
├── SOUL.md          # Persona (name, personality, tone)
├── MEMORY.md        # Long-term memory index
├── PEOPLE.md        # People directory
├── JOURNAL.md       # Memory hook, session summarize, daily journal prompts
├── config/          # Structured data
│   ├── crons.json
│   ├── reminders.json
│   └── google-token.json
├── memory/          # Daily memory files
├── sessions/        # Conversation sessions
│   └── archive/
└── skills/          # Installed skills
```

All `.md` files are customizable — edit them to change the bot's behavior, personality, and prompts.

## AI Engine (pi SDK)

Furet now uses `@mariozechner/pi-coding-agent` SDK as the core runtime:

- Session persistence is handled by `SessionManager` (`workspace/sessions/pi/*.jsonl`)
- All built-in tools from `src/tools/builtin/` are registered through `pi.registerTool`
- Gateway tasks (cron/reminder/journal) run with explicit pi session IDs
- Memory context is injected through pi hooks with a three-layer strategy:
  - `FURET.md`
  - `MEMORY.md`
  - `PEOPLE.md`

## Service Management

```bash
sudo systemctl status furet    # check status
sudo systemctl restart furet   # restart
sudo systemctl stop furet      # stop
journalctl -u furet -f         # view logs
```
