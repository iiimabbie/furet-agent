# Furet

Personal assistant Discord bot powered by `@mariozechner/pi-coding-agent`.

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

The install script automatically creates `furet.service`. You can manage it with systemctl:

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
| `furet gateway` | Start Discord bot |
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

## Configuration

### Google API

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

### Workspace Structure

`workspace/` is created by `furet install` and contains all runtime data:

```
workspace/
├── AGENT.md         # System instructions (behavior, tools, boundaries)
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
- Memory context is injected through pi hooks:
  - `AGENT.md`
  - `MEMORY.md`
  - `PEOPLE.md`

## Uninstall

```bash
# Stop and remove systemd service
sudo systemctl stop furet
sudo systemctl disable furet
sudo rm /etc/systemd/system/furet.service
sudo systemctl daemon-reload

# Remove global CLI command
npm unlink -g furet

# Delete project folder (includes workspace, sessions, memory, and all data)
rm -rf ~/.furet
```
