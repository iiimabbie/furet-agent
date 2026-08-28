# Furet

A self-hosted personal AI assistant for Discord and the terminal. Furet runs an agent loop against the Anthropic Messages API, gives it a local workspace and tools, and keeps the assistant useful across conversations without giving up control of where its data lives.

> **Early-stage project.** Furet can execute shell commands and access connected services. Run it only on infrastructure and Discord servers you trust, and review its configuration before enabling it for other people.

## What it does

- Talks in Discord through mentions, DMs from the owner, or configured ambient channels; also includes an interactive local CLI.
- Keeps per-channel sessions, archives prior conversations, and maintains daily plus long-term memory.
- Uses a workspace-first model: persona, operating instructions, people records, skills, memories, sessions, and generated files are stored locally under `workspace/`.
- Provides tools for files, shell commands, Discord moderation and messaging, scheduled jobs, reminders, Google Calendar/Gmail/Drive/Tasks, and weather.
- Supports installable workspace skills, local private plugins, and an owner-only `self_evolve` tool for proposing source changes through a stronger coding model.
- Protects configured workspace files with Soul Guardian integrity monitoring.
- Writes readable local logs, rotated into one file per local day (`logs/furet-YYYY-MM-DD.log`), with timestamps such as `[2026-08-21 09:04:52] INFO: gateway start`.

For the detailed architecture and data flow, see [material/DESIGN.md](material/DESIGN.md). To build a private tool integration, see [docs/PLUGINS.md](docs/PLUGINS.md).

## Requirements

- Node.js 24 or newer
- npm
- An Anthropic API key, or a compatible endpoint implementing the Anthropic `POST /v1/messages` API
- A Discord application token if you want to use Discord
- Linux with systemd is optional, but recommended for running the gateway as a service

## Quick start

```bash
# Clone and enter the project
git clone <repo-url> ~/.furet
cd ~/.furet

# Install dependencies, create local templates, register `furet`, and install
# a systemd service when the host supports it.
npx tsx bin/furet.ts install

# Fill in credentials and runtime settings.
$EDITOR .env
$EDITOR config.yaml

# Set your Discord user ID and optionally your first allowed channel.
furet onbord

# Start the gateway in the foreground.
furet gateway
```

`furet install` runs `npm install`, creates missing `.env`, `config.yaml`, and workspace template files, registers the `furet` command with `npm link`, and installs/enables `furet.service` when systemd is available. Existing configuration and workspace files are not overwritten. Run `furet onbord` locally before the first Discord use to save the owner Discord ID and, optionally, the first allowed channel ID.

## Configuration

### `.env` — credentials

Copying `.env.example` creates the available variables:

```dotenv
# Required for model access
LLM_API_KEY=
# Empty uses https://api.anthropic.com/v1; otherwise use the API base URL.
LLM_BASE_URL=

# Required only when Discord is enabled
DISCORD_TOKEN=

# Optional: enables semantic memory recall with Gemini embeddings
GOOGLE_API_KEY=

# Optional: enables Google Calendar, Gmail, Drive, and Tasks tools
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

```

Never commit `.env`, `config.yaml`, or `workspace/`. They are ignored by default because they can contain secrets and private assistant data.

### `config.yaml` — behavior and access

Start from `config.example.yaml`. The settings most worth reviewing before the first launch are:

```yaml
timezone: "Asia/Taipei"

llm:
  api_key: "${LLM_API_KEY}"
  base_url: "${LLM_BASE_URL}"
  currentModel: "claude-sonnet-4-6"
  codingModel: "claude-opus-4-6"

discord:
  enabled: true
  token: "${DISCORD_TOKEN}"
  owner_id: "your-discord-user-id"
  allowed_guilds: []       # Empty means all guilds.
  allowed_channels: []     # Empty means all channels.
  ambient_channels: []     # Reply without @mention in these exact channel IDs.
  respond_to_bots: false

journal:
  enabled: true
  hour: 22
  minute: 0

tools:
  bash_owner_only: true
  bash_allowed_users: []
```

`timezone` affects timestamps, memory filenames, and journal dates. Leaving it empty uses the host system timezone.

## Running Furet

### First-run Discord onboarding

```bash
furet onbord
```

This local interactive command asks for the owner Discord user ID and optionally a first channel ID, then writes `discord.owner_id` and `discord.allowed_channels` in `config.yaml`. It does not ask the gateway to trust the first Discord user it sees. The owner’s preferred form of address and assistant persona are collected privately in the first Discord conversation.

### Foreground gateway

```bash
furet gateway
```

Use this for development or for hosts without systemd.

### systemd service

```bash
sudo systemctl start furet
sudo systemctl stop furet
sudo systemctl restart furet
sudo systemctl status furet
journalctl -u furet -f
```

The installer creates `furet.service` only on Linux hosts where systemd is detected. If you customize the unit file, run `sudo systemctl daemon-reload` before restarting it.

### Logs

Furet writes application logs to `logs/`, split into one file per day named
`logs/furet-YYYY-MM-DD.log`. The date follows the local time zone
(`config.timezone`, e.g. `Asia/Taipei`), so a new file starts at local midnight
without restarting the gateway. Existing daily files are appended to, never
overwritten. Log entries use local time and a human-readable format:

```text
[2026-08-21 09:04:52] INFO: discord trigger {"sessionId":"...","author":"owner"}
```

Set `LOG_LEVEL` before launching the gateway to control verbosity. The default is `debug`; use `info` in routine operation if you do not need tool-level diagnostic logs.

```bash
LOG_LEVEL=info furet gateway
```

## Using the assistant

### Local CLI

```bash
furet
```

Type `new` to archive the current CLI conversation and start another one. Type `exit` or `quit` to leave the CLI.

### Discord

By default, Furet responds when mentioned. It can also reply without a mention in the channel IDs listed in `discord.ambient_channels`. Threads do not inherit ambient-channel behavior from their parent channel.

Available slash commands:

- `/new` — archive the current channel session and start a new conversation.
- `/status` — show model, session, and token information.
- `/compact` — summarize older context while retaining recent messages.
- `/task` — list Google Tasks.
- `/model` — switch models; owner only.
- `/google-auth` — finish Google OAuth authorization; owner only.
- `/restart` — exit the gateway so its process manager can restart it; owner only.
- `/plugin 安裝 連結:<GitHub URL>` / `/plugin 卸載 外掛:<installed plugin>` — owner-only plugin management.

## Workspace and data

`workspace/` is Furet's private runtime area. `furet install` creates the prompt templates; the agent then maintains the operational data below.

```text
workspace/
├── AGENT.md            # Operating rules and tool behavior
├── SOUL.md             # Persona and voice
├── OWNER.md            # Owner identity and permissions
├── PEOPLE.md           # People directory
├── MEMORY.md           # Curated long-term memory
├── JOURNAL.md          # Daily-memory and journal prompts
├── attachments/        # Generated and downloaded files
├── config/             # SQLite DB, cron/reminder data, OAuth tokens
├── memory/             # Daily memory files
├── sessions/           # Active sessions and archived conversations
└── skills/             # Installed skills
```

Keep this directory private and back it up. It can contain conversation history, OAuth tokens, uploaded files, and personal notes.

## Security model

Furet is designed for a personal, trusted deployment—not as a sandboxed public bot.

- `bash` runs arbitrary host commands without a sandbox. With `tools.bash_owner_only: true` (the default), only the configured owner and any IDs in `bash_allowed_users` can use it.
- High-impact tools—such as source evolution, Gmail, Google Drive, Calendar, scheduling, and Discord message mutation—are owner-only.
- Use `discord.allowed_guilds` and `discord.allowed_channels` to minimize where the bot can be triggered.
- Treat `workspace/config/google-token.json`, `.env`, log files, and all workspace data as private.
- Review every third-party skill before installing it. A skill can add instructions that influence tool use.

## Google integration

To enable Calendar, Gmail, Drive, and Tasks:

1. Create a Google Cloud project.
2. Enable Calendar API, Gmail API, Drive API, and Tasks API.
3. Create a Desktop OAuth client.
4. Put its client ID and secret in `.env`.
5. Restart Furet and use `/google-auth` as the owner to complete authorization.

`GOOGLE_API_KEY` is separate: it is only used for Gemini embedding-based semantic memory recall. Without it, memory search still works through full-text search.

## Private plugins

Private plugins can register deployment-specific tools, recurring background jobs, and lifecycle event handlers without editing the built-in registry or committing private integrations to this repository. Managed plugins are installed into `workspace/plugins/` and registered in `workspace/config/plugins.json`:

```bash
furet plugin install <git-url>
furet plugin install <git-url> --workspace <package-name-or-path>
furet plugin list
furet plugin enable <name>
furet plugin disable <name>
furet plugin update [name]
furet plugin remove <name>
```

Discord exposes one owner-only `/plugin` command with two subcommands. `/plugin 安裝` accepts a GitHub repository URL or a package URL such as `https://github.com/owner/repository/tree/main/packages/example-plugin`; package URLs automatically select the workspace path. `/plugin 卸載` uses autocomplete populated from the currently installed managed plugins, matching the `/model` selection experience. The caller is compared directly with `discord.owner_id`, because installing a plugin executes trusted code on the host. Discord installation accepts public HTTPS GitHub links; host-side CLI commands remain available for local paths, SSH sources, updates, and enable/disable maintenance.

A plugin package declares its entry as `"furet": { "plugin": "./dist/index.js" }` in `package.json`. The installer runs dependency installation and an optional `build` script, but deliberately does not restart the gateway. Tool permissions still flow through the central registry, plugin schedules follow plugin startup/shutdown automatically, and all plugin code runs inside the Furet process without a sandbox.

See [docs/PLUGINS.md](docs/PLUGINS.md) for packaging, monorepo installation, the API contract, configuration, security guidance, lifecycle behavior, and troubleshooting.

## Development

```bash
npm install
npm run build
npm run dev
```

`npm run dev` starts the local CLI. `npm run build` type-checks and emits JavaScript into `dist/`.

## Uninstall

```bash
sudo systemctl stop furet
sudo systemctl disable furet
sudo rm /etc/systemd/system/furet.service
sudo systemctl daemon-reload
npm unlink -g furet
rm -rf ~/.furet
```

Only run the final command after backing up any workspace data you want to keep.

## License

[MIT](LICENSE)
