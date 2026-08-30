# Furet Plugin Guide

Furet plugins are trusted local ECMAScript modules that can contribute private tools, recurring background jobs, Discord slash commands, and lifecycle event handlers without modifying the public core registry. They are intended for deployment-specific integrations such as home automation, private APIs, game helpers, internal databases, and personal workflows.

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

`furet.name` is optional and defaults to the unscoped npm package name. `furet.plugin` is required and must point to a file inside the package. The installer runs `npm install`, runs the selected package's `build` script when present, verifies that the entry exists, records the checkout under `workspace/plugins/`, and registers the entry in `workspace/config/plugins.json`. It never restarts the gateway automatically.

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

Managed source metadata and activation state are stored in `workspace/config/plugins.json`. The runtime loader merges these managed entries with manually configured `config.yaml` plugins, so managed installation works even when `config.yaml` is mounted read-only. Removing the final plugin that uses a checkout moves that checkout to `workspace/.trash/` rather than deleting it permanently. Local-directory installs are copied into the managed area and cannot be updated in place; remove and reinstall them to refresh the copy.

The installer executes trusted package scripts and the loaded plugin later runs inside the Furet process. Review third-party code before installing it. A restart is required after install, enable, disable, update, or remove.

### Discord slash command

The configured owner invokes a single command:

```text
/plugin 動作:安裝 目標:https://github.com/owner/repository/tree/main/packages/example-plugin
/plugin 動作:更新 目標:<choose an installed plugin>   # omit 目標 to update all
/plugin 動作:卸載 目標:<choose an installed plugin>
```

The required `動作` option selects installation, update, or removal. The shared `目標` string accepts either a repository URL or a GitHub package URL in `/tree/<branch>/<path>` form when installing; package URLs inspect the remote branch refs before deriving the repository checkout and npm workspace path, so branch names containing `/` are supported. For update and removal, autocomplete exposes the managed plugin registry like `/model`, so the owner chooses from currently installed plugins instead of typing a name from memory. Update may omit `目標` to update all managed sources; installation and removal require it at runtime.

Every `/plugin` invocation compares the caller directly with `discord.owner_id`; no guild role or channel permission can substitute for that identity check. Replies are ephemeral, and installation defers the interaction before cloning, installing dependencies, or building. Discord installation accepts public HTTPS `github.com` links only and rejects embedded credentials. Private sources, local directories, SSH URLs, list, enable, and disable remain host-side CLI operations.

A restart is still required after installation, update, or removal. The command reports the completed persistent change but does not restart Furet automatically.

## Write your first plugin

A plugin does not need a Furet source checkout or a special SDK. The smallest installable plugin is an ordinary ECMAScript package with two files:

```text
hello-furet-plugin/
├── package.json
└── index.mjs
```

### 1. Declare the package entry

Create `package.json`:

```json
{
  "name": "hello-furet-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "furet": {
    "name": "hello-furet",
    "plugin": "./index.mjs"
  }
}
```

The installer reads `furet.plugin`; npm's `main` or `exports` field does not replace it. The path must stay inside this package. `furet.name` is the stable name shown by plugin management and defaults to the unscoped npm package name when omitted.

### 2. Export a plugin module

Create `index.mjs`:

```javascript
const greetTool = {
  name: "hello_greet",
  description: "Greet a person by name.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The person to greet.",
      },
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
    name: "hello-furet",
  },
  tools: [
    {
      tool: greetTool,
      group: "greetings",
      exposure: "match",
      keywords: ["greet", "hello"],
      aliases: ["say hello"],
      ownerOnly: true,
    },
  ],
};
```

A plugin must export:

- `manifest.name`, unique among loaded plugins.
- At least one item in `tools`, `schedules`, `commands`, or `events`.
- Tool `execute()` functions that always resolve to a string, including recoverable errors.

This example uses `exposure: "match"`, so Furet offers the tool schema only when the request matches its keywords or aliases. Use `on-demand` for catalog-only tools and reserve `native` for small tools needed on nearly every turn.

### 3. Publish and install it

Push the two files to the root of a public GitHub repository, then install it from Discord:

```text
/plugin 動作:安裝 目標:https://github.com/owner/hello-furet-plugin
```

Or install it from the host:

```bash
furet plugin install https://github.com/owner/hello-furet-plugin.git
```

Restart Furet after installation. Then ask the assistant to use the greeting tool and inspect the gateway log if it is not selected or loaded.

### 4. Add dependencies or a build step

A plugin is a normal npm package. Declare runtime libraries in `dependencies`. If `package.json` contains a `build` script, the installer runs it after `npm install` and before checking `furet.plugin`.

A typical TypeScript package looks like this:

```text
hello-furet-plugin/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

```json
{
  "name": "hello-furet-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "@types/node": "^25.0.0",
    "typescript": "^6.0.0"
  },
  "furet": {
    "name": "hello-furet",
    "plugin": "./dist/index.js"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true
  },
  "include": ["src/**/*.ts"]
}
```

Furet does not currently publish a separate plugin SDK package. Authors can use the contracts documented below, write plain JavaScript, or copy the relevant TypeScript interfaces from `src/tools/plugin-types.ts` into their own project for compile-time checking. The runtime contract is structural; the plugin must not import Furet's private source files at runtime.

### 5. Choose the capability you need

- **Tool:** the model invokes an operation in response to a conversation or another agent task.
- **Schedule:** Furet runs a recurring background callback declared by the plugin.
- **Slash command:** Furet registers a Discord command declared by the plugin and routes executions back to it.
- **Event:** Furet runs the plugin after a supported core event, currently `journal:completed`.
- **Lifecycle:** `manifest.start(context)` opens clients or validates configuration; `manifest.stop(context)` performs graceful cleanup.

A plugin may combine these capabilities. The complete example in the next section shows one tool, one schedule, and one event together; the reference sections explain every field and failure rule.

### Development loop

1. Keep the plugin in its own repository or npm-workspaces monorepo.
2. Run its own lint, typecheck, and tests before installing it.
3. Install it into a non-production Furet deployment first.
4. Restart Furet and check for the plugin's `started` state and capability counts in logs or `/status`.
5. Exercise every tool, schedule, and event with unavailable credentials and failing upstream services as well as the successful path.
6. Push plugin changes, run `furet plugin update <name>`, and restart to load the new module.

Do not develop by editing files under `workspace/plugins/`; that directory is a managed checkout and may be replaced by update or reinstall operations.

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
  commands?: PluginSlashCommandRegistration[];
  events?: PluginEventRegistration[];
}

interface PluginManifest {
  name: string;
  start?: (context: PluginRuntimeContext) => Promise<void> | void;
  stop?: (context: PluginRuntimeContext) => Promise<void> | void;
}

interface PluginMessageTransport {
  sendText(input: { channelId: string; content: string }): Promise<{ messageId: string }>;
  editText(input: { channelId: string; messageId: string; content: string }): Promise<{
    messageId: string;
    migrated: boolean;
  }>;
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
  messages: PluginMessageTransport;
  config: PluginConfigStore;
}
```

At least one of `tools`, `schedules`, `commands`, or `events` must contain a capability. The canonical TypeScript definitions are in `src/tools/plugin-types.ts`.

### Manifest

- `name` is required and unique across loaded plugins. It namespaces background-job diagnostics.
- `start` runs once after the Discord client is ready (when Discord is enabled), before the plugin's tools, schedules, and events become active. This guarantees that `context.messages` is usable during `start`. If Discord is disabled or login fails, the lifecycle still runs, but message operations reject with a clear transport-unavailable error.
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

## Discord slash commands

Plugins may declare top-level Discord slash commands. Furet validates them during plugin loading, combines commands from every started plugin with the built-in command list, and registers the complete list when the Discord gateway becomes ready. Installing or updating a command therefore requires a gateway restart.

```typescript
interface PluginSlashCommandRegistration {
  name: string;
  description: string;
  options?: Array<{
    name: string;
    description: string;
    type: "string" | "integer" | "boolean" | "channel";
    required?: boolean;
    choices?: Array<{ name: string; value: string | number }>;
  }>;
  ownerOnly?: boolean;
  ephemeral?: boolean;
  execute(
    args: Record<string, string | number | boolean | undefined>,
    context: {
      userId: string;
      channelId: string;
      guildId?: string;
      config: PluginConfigStore;
    },
  ): Promise<string> | string;
}
```

- Command names are globally unique across plugins. A name that conflicts with a built-in Furet command is not registered.
- `ownerOnly` defaults to `true`; `ephemeral` defaults to `true`.
- Handlers return the text Furet sends as the interaction result. Non-string results become recoverable command errors.
- Options use Discord-native string, integer, boolean, and channel inputs. Static choices are supported for string and integer options.
- Commands are suitable for plugin settings and explicit operations. They do not expose the agent tool registry or bypass tool authorization.

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
- The full `AgentResponse` is returned. If a workflow needs to publish generated text without routing it back through an agent turn, use the trusted `context.messages` transport described below.

The wrapper is intended for private workflows such as post-processing a journal. It is not an authorization boundary: the plugin module itself is already trusted in-process code.

## Plugin message transport

Lifecycle hooks, schedules, and any tool closures initialized by `manifest.start(context)` may retain `context.messages`. It exposes only text send/edit operations, not the Discord client, token, raw interactions, or other users' messages:

```typescript
await context.messages.sendText({
  channelId: "CHANNEL_ID",
  content: "Private workflow completed.",
});

const edited = await context.messages.editText({
  channelId: "CHANNEL_ID",
  messageId: "MESSAGE_ID",
  content: "Private workflow updated.",
});
// Persist edited.messageId. It changes when a historical Components V2 message
// is replaced with a standard V1 message.
```

The host sends standard Discord V1 text messages and rejects an edit unless the target message belongs to the bot. Content is passed through unchanged: the transport does not expand Application Emoji aliases, repair ANSI, format Markdown, or otherwise rewrite the plugin-owned string. Each operation accepts at most 2,000 JavaScript string characters; over-limit content is rejected with an explicit error rather than silently split, because transparent splitting would break single-message edit identity.

`editText()` returns the authoritative message ID. Normal V1 messages are edited in place with `migrated: false`. A historical Components V2 message cannot accept V1 `content`, so the host sends a V1 replacement, deletes the old message, and returns the replacement ID with `migrated: true`. Persist the returned ID; do not assume it equals the input ID.

This transport is for plugin-owned, persisted workflows that must deliver exact generated string content without making the agent reserialize it. It is not a public agent tool and does not expose arbitrary Discord client access.

## Secrets and configuration

Every loaded plugin receives a private YAML configuration store at:

```text
workspace/config/plugins/<manifest.name>.yaml
```

The host creates an empty file when the plugin loads, uses mode `0600`, and replaces later writes atomically. Configuration stays outside managed source checkouts, so `/plugin update` cannot overwrite it and plugin repositories do not accidentally commit deployment values.

```typescript
const defaults = { channel_id: "", feature: { enabled: true } };

const current = context.config.read(defaults);
context.config.update(defaults, value => ({
  ...value,
  channel_id: "CHANNEL_ID",
}));
```

The reserved `schedules` object can override declarative jobs at the next gateway start:

```yaml
schedules:
  daily-check:
    enabled: true
    schedule: "30 8 * * *"
    timezone: "Asia/Taipei"
```

A plugin slash command can write this configuration and tell the owner to run `/restart`. Schedule expressions and timezones are revalidated while the plugin loads; invalid overrides fail that plugin without crashing the gateway.

Do not put private credentials in `config.example.yaml`, committed files, tool descriptions, error messages, or returned tool text. Environment variables remain appropriate for secrets that should not be written to disk:

```javascript
const apiToken = process.env.PRIVATE_SERVICE_TOKEN;
if (!apiToken) throw new Error("PRIVATE_SERVICE_TOKEN is not configured");
```

## Loading and failure behavior

Plugin loading is fail-soft and all-or-nothing:

- Missing files, import errors, invalid manifests, duplicate plugin names, invalid tools, invalid schedules, invalid slash commands, unsupported events, and duplicate IDs are logged.
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
