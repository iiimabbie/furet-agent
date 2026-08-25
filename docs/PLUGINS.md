# Furet Plugin Guide

Furet plugins are local ECMAScript modules that register private tools without modifying `src/tools/registry.ts`. They are intended for deployment-specific integrations—home automation, private APIs, game helpers, internal databases, and similar capabilities that should not live in the public repository.

> Plugins run inside the Furet process with the same operating-system privileges as Furet. They are not sandboxed. Only load code you trust.

## Quick start

Create a module outside the repository, for example `~/furet-plugins/hello/index.mjs`:

```javascript
const helloTool = {
  name: "private_hello",
  description: "Return a private greeting for a named person.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Person to greet.",
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
};
```

Add the module to the root `config.yaml`:

```yaml
plugins:
  - path: ../furet-plugins/hello/index.mjs
    enabled: true
```

A relative path is resolved from the Furet repository root, not from the current working directory. Absolute paths are also accepted.

Restart Furet and look for a log entry similar to:

```text
INFO: plugin loaded {"plugin":"private-hello","toolCount":1}
```

When tool exposure is enabled, an `on-demand` tool can be found with `tool_catalog.search`, described with `tool_catalog.describe`, and executed through `tool_catalog.call`. When exposure is disabled, plugin tools are included in the legacy full tool list.

## Module contract

A plugin module may use a default export, or directly export `manifest` and `tools` with the same shape:

```typescript
interface PluginModule {
  manifest: PluginManifest;
  tools: PluginToolRegistration[];
}

interface PluginManifest {
  name: string;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

interface PluginToolRegistration {
  tool: Tool;
  group: string;
  exposure?: "native" | "match" | "index" | "on-demand";
  keywords?: string[];
  aliases?: string[];
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

The canonical TypeScript definitions are in `src/tools/plugin-types.ts` and `src/types.ts`.

### Manifest

- `name` is required and is used for logs and diagnostics. It is not a tool-name namespace.
- `start` is optional and runs once during gateway startup, after registration and before background services begin accepting traffic.
- `stop` is optional and runs during normal `SIGINT` or `SIGTERM` shutdown.
- A lifecycle hook failure is logged and isolated from other plugins.
- `/restart` exits immediately for systemd to restart the process, so it intentionally does not wait for plugin `stop` hooks. A plugin must tolerate abrupt process termination.

### Tool

- `name` must be non-empty and globally unique across built-in tools and all plugins. Names are not automatically prefixed with the plugin name.
- `description` should clearly state what the tool does and when it should be used.
- `parameters` is the JSON Schema sent to the model.
- `execute` receives an argument object and must resolve to a string.
- Validate security-sensitive arguments inside `execute`; the plugin loader validates the registration shape, not every runtime value.
- Return useful error text for expected failures. Throwing is reserved for unexpected failures and is reported as a tool execution error.

The first plugin API supports text results only. Returning images or structured content for same-turn model vision requires a future rich tool-result protocol.

### Registration metadata

#### `group`

Required non-empty capability group. It is used by the tool index and `tool_catalog.list_groups`.

Choose a stable, understandable label such as `home automation`, `private CRM`, or `game helpers`.

#### `exposure`

Controls visibility, not authorization:

- `native`: the full tool schema is sent on every model request. Use sparingly.
- `match`: the schema is sent only when deterministic prompt matching succeeds. At least one non-empty `keyword` or `alias` is required.
- `index`: the tool's group appears in the tool index, while its schema is retrieved through `tool_catalog` when needed.
- `on-demand`: hidden from the normal index and found only through explicit name/search. This is the default for plugin tools.

#### `keywords`

Non-empty Chinese or English strings used by `match` exposure. Prefer specific phrases over broad words that would expose the tool too often.

#### `aliases`

Alternative tool names or phrases. Exact aliases receive stronger matching priority and are also useful for catalog search.

#### `modelPredicate`

Optional model capability gate:

```javascript
modelPredicate: model => model.startsWith("gpt-"),
```

This is a capability filter, not an identity or permission check.

#### `ownerOnly`

Defaults to `true`. Set it to `false` only when the tool and all data it can access are safe for non-owner Discord callers.

Exposure and permission are separate. Hiding a tool does not secure it; exposing a schema does not grant permission. Plugin execution always returns through the central `executeTool()` path, including calls proxied by `tool_catalog`.

## Secrets and configuration

Do not put private credentials in `config.example.yaml`, committed files, tool descriptions, error messages, or returned tool text.

A plugin can read deployment secrets from environment variables:

```javascript
const apiToken = process.env.PRIVATE_SERVICE_TOKEN;
if (!apiToken) {
  throw new Error("PRIVATE_SERVICE_TOKEN is not configured");
}
```

For larger private configuration, keep a separate ignored file outside the public repository and resolve its path explicitly. Never return secret values to the model.

## Loading and failure behavior

Plugin loading is intentionally fail-soft:

- Missing files, import errors, invalid manifests, invalid registration metadata, and duplicate tool names are logged.
- One broken plugin does not prevent the gateway from starting.
- A plugin is registered all-or-nothing. If any tool in it is invalid, none of its tools are registered.
- Loading is idempotent within one process. Editing a plugin file requires a process restart.
- Disabled entries remain in configuration but are skipped.

## Recommended plugin structure

```text
furet-plugins/
└── private-service/
    ├── index.mjs
    ├── client.mjs
    ├── package.json
    └── README.md
```

Keep transport/client code separate from Furet tool declarations. This makes it easier to test the private integration without starting the entire gateway.

If a plugin has its own dependencies, install them in the plugin directory and give it its own `package.json`. Node resolves imports from the plugin module's location.

## Author checklist

Before enabling a plugin:

- Tool names are globally unique and use a recognizable prefix when appropriate.
- Every tool has a precise description and JSON Schema.
- `execute` validates sensitive arguments and returns only non-secret text.
- `ownerOnly` remains `true` unless non-owner access was deliberately reviewed.
- `match` tools have at least one specific keyword or alias.
- Startup and shutdown hooks are idempotent and tolerate partial initialization.
- Network clients have timeouts; shutdown does not depend on an unbounded wait.
- The plugin tolerates abrupt `/restart` termination.
- Secrets stay in environment variables or private ignored configuration.
- Furet starts successfully when the plugin is unavailable or misconfigured.

## Troubleshooting

### `plugin path does not exist; skipping`

Check the resolved path in the log. Relative paths start at the Furet root.

### `plugin import failed; skipping`

Run the module directly with the same Node.js version as Furet and verify its imports and dependencies. Use `.mjs` for the most portable no-build example.

### `plugin module does not export a valid ...`

Ensure the module exports both a non-empty `manifest.name` and a `tools` array, either as a default export or direct named exports.

### `plugin tool rejected; skipping whole plugin`

The log's `reason` identifies the invalid field. Common causes are a duplicate tool name, an unsupported exposure value, a missing group, or `match` exposure without keywords/aliases.

### The tool does not appear in the prompt

This may be expected:

- `on-demand` tools are intentionally absent from the normal index.
- `index` tools appear by group, not full schema.
- `match` tools appear only after a keyword/alias match.
- `modelPredicate` may reject the active model.
- `ownerOnly` can reject execution even when the tool is visible.

Use `tool_catalog.search` and `tool_catalog.describe` to inspect registered non-native tools when exposure is enabled.
