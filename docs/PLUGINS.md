# Furet Plugin Guide

Furet plugins are trusted local ECMAScript modules that can contribute private tools, recurring background jobs, and lifecycle event handlers without modifying the public core registry. They are intended for deployment-specific integrations such as home automation, private APIs, game helpers, internal databases, and personal workflows.

> Plugins run inside the Furet process with the same operating-system privileges as Furet. They are not sandboxed. Only load code you trust.

## Installation

Furet exposes the same managed plugin operations through the host CLI and an owner-only Discord slash command. Both paths call the same plugin manager; neither path restarts the gateway automatically.

### Host CLI

A plugin package declares its runtime entry in `package.json`:

```json
{
  "name": "@example/private-hello",
  "type": "module",
  "furet": {
    "name": "private-hello",
    "plugin": "./dist/index.js"
  }
}
```

`furet.name` is optional and defaults to the unscoped npm package name. `furet.plugin` is required and must point to a file inside the package. The installer runs `npm install`, runs the selected package's `build` script when present, verifies that the entry exists, records the checkout under `workspace/plugins/`, and registers the entry in `config.yaml`. It never restarts the gateway automatically.

```bash
# Single-package repository
furet plugin install ssh://git@example.invalid/owner/private-hello.git

# npm workspace monorepo; accepts a package name or relative package path
furet plugin install ssh://git@example.invalid/owner/furet-plugins.git \
  --workspace private-hello

furet plugin list
furet plugin disable private-hello
furet plugin enable private-hello
furet plugin update private-hello   # omit the name to update every managed source
furet plugin remove private-hello
```

Managed source metadata is stored in `workspace/config/plugins.json`; activation remains in `config.yaml`, so the runtime loader has one source of truth. Removing the final plugin that uses a checkout moves that checkout to `workspace/.trash/` rather than deleting it permanently. Local-directory installs are copied into the managed area and cannot be updated in place; remove and reinstall them to refresh the copy.

The installer executes trusted package scripts and the loaded plugin later runs inside the Furet process. Review third-party code before installing it. A restart is required after install, enable, disable, update, or remove.

### Discord slash command

The configured owner can manage plugins without logging into the host:

```text
/plugin install source:<git-url-or-local-path> workspace:<optional>
/plugin list
/plugin enable name:<plugin>
/plugin disable name:<plugin>
/plugin update name:<optional>
/plugin remove name:<plugin>
```

Every `/plugin` subcommand compares the Discord caller directly with `discord.owner_id`; no guild role or channel permission can substitute for that identity check. Replies are ephemeral, and install/update defer the interaction before running dependency installation or builds. Do not put passwords or tokens in an HTTPS source URL—use the host's existing SSH credentials for private repositories.

## Manual quick start

For development, or for a module that is not packaged for the installer, create it outside the repository and register it manually. For example `~/furet-plugins/hello/index.mjs`:

```javascript
const helloTool = {
  name: "private_hello",
  description: "Return a private greeting for a named person.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Person to greet." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(args) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return "Error: name must be a non-empty string.";
    return `Hello, ${name}.`;
  },
};

export default {
  manifest: {
    name: "private-hello",
    async start() {
      // Optional: connect clients or initialize resources.
    },
    async stop() {
      // Optional: close clients or release resources.
    },
  },
  tools: [
    {
      tool: helloTool,
      group: "private greetings",
      exposure: "on-demand",
      aliases: ["private hello"],
      ownerOnly: true,
    },
  ],
  schedules: [
    {
      id: "daily-check",
      name: "Daily private check",
      schedule: "0 8 * * *",
      timezone: "Asia/Taipei",
      async run({ ask }) {
        await ask("Run the private daily check and update its local state. Do not send a Discord message.");
      },
    },
  ],
  events: [
    {
      event: "journal:completed",
      id: "after-journal",
      async run({ date }, { ask }) {
        await ask(`The built-in journal for ${date} has completed. Run the private post-processing workflow.`);
      },
    },
  ],
};
```

Add the module to the root `config.yaml`:

```yaml
plugins:
  - path: ../furet-plugins/hello/index.mjs
    enabled: true
```

A relative path is resolved from the Furet repository root, not from the current working directory. Absolute paths are also accepted.

Restart Furet. A successful load logs the tool, schedule, and event counts. Plugin schedules start automatically after the plugin lifecycle succeeds; they are not copied into `workspace/config/crons.json`.

## Module contract

A plugin module may use a default export, or directly export `manifest` plus the optional capability arrays:

```typescript
interface PluginModule {
  manifest: PluginManifest;
  tools?: PluginToolRegistration[];
  schedules?: PluginScheduleRegistration[];
  events?: PluginEventRegistration[];
}

interface PluginManifest {
  name: string;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

interface PluginRuntimeContext {
  ask(
    prompt: string,
    options?: {
      systemPrompt?: string;
      maxTurns?: number;
      model?: string;
    },
  ): Promise<AgentResponse>;
}
```

At least one of `tools`, `schedules`, or `events` must contain a capability. The canonical TypeScript definitions are in `src/tools/plugin-types.ts`.

### Manifest

- `name` is required and unique across loaded plugins. It namespaces background-job diagnostics.
- `start` runs once during gateway startup, before the plugin's tools, schedules, and events become active.
- A plugin with `start` remains hidden from tool schemas and `tool_catalog`, and its background capabilities remain inactive, until `start` succeeds.
- Each `start` hook has a 10-second timeout. A throw or timeout marks the plugin failed while the gateway continues starting.
- `stop` runs during normal `SIGINT` or `SIGTERM` shutdown after plugin schedules have been stopped.
- Lifecycle failures are logged and isolated from other plugins.
- `/restart` exits immediately for systemd to restart the process, so it intentionally does not wait for plugin `stop` hooks. A plugin must tolerate abrupt termination.

## Tools

```typescript
interface PluginToolRegistration {
  tool: Tool;
  group: string;
  exposure?: "native" | "match" | "index" | "on-demand";
  keywords?: string[];
  aliases?: string[];
  signals?: ("hasDateTime" | "hasAttachment" | "hasImageEditRequest")[];
  modelPredicate?: (model: string) => boolean;
  ownerOnly?: boolean;
}

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}
```

- Tool names are globally unique across built-ins and all plugins.
- `execute` must resolve to a string. A non-string result becomes a recoverable tool error instead of crashing the agent loop.
- `ownerOnly` defaults to `true`. Set it to `false` only when the tool and all data it can access are safe for non-owner callers.
- Plugin tools use the same central `executeTool()` path as built-ins, including owner-only checks, model gates, path guards, confirmations, and `tool_catalog.call`.

### Exposure metadata

- `native`: full schema is sent on every model request. Use sparingly.
- `match`: schema is sent only after deterministic prompt matching. Declare at least one keyword, alias, or supported signal.
- `index`: group appears in the tool index; schema is retrieved through `tool_catalog`.
- `on-demand`: absent from the normal index and found only through explicit name or catalog search. This is the default.

Exposure controls visibility, not authorization.

## Scheduled background jobs

```typescript
interface PluginScheduleRegistration {
  id: string;
  name?: string;
  schedule: string;
  timezone?: string;
  timeoutMs?: number;
  run: (context: PluginRuntimeContext) => Promise<void> | void;
}
```

- `id` is required, unique within the plugin, and must match `[a-zA-Z0-9][a-zA-Z0-9._-]*`.
- `schedule` is a node-cron expression (five fields, with optional seconds field) validated by `node-cron` during plugin loading.
- `timezone` is an optional IANA timezone passed to `node-cron`.
- Plugin schedules are declarative runtime capabilities. They are not user cron records, are not written to `crons.json`, and are not modified by `cron_*` tools.
- Schedules start automatically only after plugin startup succeeds and stop automatically during graceful plugin shutdown.
- The same job never runs concurrently with itself. A tick arriving while the previous run is active is skipped and logged.
- `timeoutMs` defaults to 10 minutes and produces a warning when exceeded. JavaScript callbacks cannot be force-cancelled safely, so the run remains marked active until it actually settles; this preserves the no-overlap guarantee.
- A thrown error is logged and isolated. It does not stop the scheduler or gateway.
- `/status` shows the number of registered and currently running plugin jobs.

## Event handlers

```typescript
interface JournalCompletedEvent {
  event: "journal:completed";
  date: string;
  result: string;
}

interface PluginEventRegistration {
  event: "journal:completed";
  id: string;
  timeoutMs?: number;
  run: (
    payload: JournalCompletedEvent,
    context: PluginRuntimeContext,
  ) => Promise<void> | void;
}
```

The initial event API supports `journal:completed`.

- The event is emitted after the built-in journal agent request resolves successfully.
- `date` is the date fixed at the beginning of the journal run; `result` is the journal agent's final text response.
- Handlers run only for plugins in the `started` state.
- Different handlers run independently. One handler's throw, long runtime, or failure does not change the built-in journal result and does not block other plugins.
- Handler IDs follow the same safe ID format as schedule IDs and are unique per event within a plugin.
- If the same handler is still active when the event fires again, the duplicate invocation is skipped.

A handler that needs the generated Markdown should read the journal file itself using the supplied date rather than assuming the agent's final response contains the document body.

## Plugin-owned agent requests

Scheduled jobs and event handlers receive a limited `context.ask()` wrapper:

- Requests run under the trusted `plugin` trigger in a fresh isolated agent context.
- Plugins may choose `systemPrompt`, `maxTurns`, and `model`.
- Plugins cannot override the trigger, impersonate a Discord user, inject a Discord session, or attach progress callbacks through this API.
- The full `AgentResponse` is returned. If the request produces attachments or text that should be delivered externally, the plugin is responsible for that delivery and retention policy.

The wrapper is intended for private workflows such as post-processing a journal. It is not an authorization boundary: the plugin module itself is already trusted in-process code.

## Secrets and configuration

Do not put private credentials in `config.example.yaml`, committed files, tool descriptions, error messages, or returned tool text.

A plugin can read deployment secrets from environment variables:

```javascript
const apiToken = process.env.PRIVATE_SERVICE_TOKEN;
if (!apiToken) throw new Error("PRIVATE_SERVICE_TOKEN is not configured");
```

For larger private configuration, keep a separate ignored file outside the public repository and resolve its path explicitly.

## Loading and failure behavior

Plugin loading is fail-soft and all-or-nothing:

- Missing files, import errors, invalid manifests, duplicate plugin names, invalid tools, invalid schedules, unsupported events, and duplicate IDs are logged.
- One broken plugin does not prevent the gateway from starting.
- If any declared capability is invalid, none of that plugin's capabilities are activated.
- Tool names may be reserved during loading, but tools and background capabilities remain inactive until startup succeeds.
- Loading is idempotent within one process. Editing a plugin file requires a process restart.
- Disabled config entries are skipped.

## Managed monorepo structure

A private npm-workspaces repository can expose several independently installable plugins:

```text
furet-plugins/
├── package.json
├── package-lock.json
└── packages/
    ├── dream-journal/
    │   ├── package.json   # contains furet.plugin
    │   └── src/
    └── private-service/
        ├── package.json   # contains furet.plugin
        └── src/
```

Install each package with the same repository URL and a different `--workspace`. Furet reuses one managed checkout and removes it only after the final installed plugin from that source is removed.

## Recommended plugin structure

```text
furet-plugins/
└── private-service/
    ├── index.mjs
    ├── client.mjs
    ├── workflows.mjs
    ├── package.json
    └── README.md
```

Keep transport clients, tool declarations, and background workflows separate. If a plugin has dependencies, install them in the plugin directory and give it its own `package.json`; Node resolves imports from the plugin module's location.

## Author checklist

Before enabling a plugin:

- The manifest name is unique and stable.
- Tool names and schedule/event IDs are unique and recognizable.
- Every tool has a precise description and JSON Schema.
- `ownerOnly` remains `true` unless non-owner access was deliberately reviewed.
- Cron expressions and timezones are explicit and correct.
- Scheduled callbacks are idempotent and safe to retry after a process restart.
- Long jobs have suitable timeouts and external network calls have their own abort timeouts.
- Startup and shutdown hooks tolerate partial initialization and abrupt `/restart` termination.
- Event handlers do not assume the event payload contains full file contents.
- Secrets stay in environment variables or private ignored configuration.
- Furet starts successfully when the plugin's external dependency is unavailable.

## Troubleshooting

### `plugin path does not exist; skipping`

Check the resolved path in the log. Relative paths start at the Furet root.

### `plugin module does not export a valid manifest/capability shape`

Ensure the module exports a non-empty `manifest.name`, optional capability arrays with the correct types, and at least one tool, schedule, or event.

### `plugin schedule rejected`

Check the logged reason. Common causes are an invalid cron expression, duplicate ID, malformed timezone field, non-positive timeout, or missing `run` function.

### `plugin event rejected`

The initial API accepts only `journal:completed`. Check the event name, handler ID, timeout, and `run` function.

### The plugin is loaded but no schedule runs

Check `/status` and logs for the plugin state. Schedules are registered only after `manifest.start()` succeeds. Editing a plugin requires a gateway restart.

### A job tick was skipped

The previous run with the same runtime key is still active. Inspect its logs and external calls; increasing the cron interval or adding network abort timeouts may be appropriate.

### The tool does not appear in the prompt

This may be expected for `on-demand`, `index`, or unmatched `match` tools. Use `tool_catalog.search` and `tool_catalog.describe`; also check that the plugin state is `started` and the active model passes `modelPredicate`.
