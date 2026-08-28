import {
  installPlugin,
  listPlugins,
  removeManagedPlugin,
  setManagedPluginEnabled,
  updatePlugins,
} from "./plugin-manager.js";
import {
  beginGiteaPluginAuth,
  completeGiteaPluginAuth,
  listPluginGitAuth,
  removePluginGitAuth,
} from "./plugin-git-auth.js";
import { loadConfig } from "./config.js";

function usage(): never {
  console.error(`Usage:
  furet plugin install <git-url-or-local-path> [--workspace <name-or-relative-path>]
  furet plugin list
  furet plugin enable <name>
  furet plugin disable <name>
  furet plugin update [name]
  furet plugin remove <name>
  furet plugin auth login <gitea-url> [--client-id <id>] [--redirect-uri <uri>]
  furet plugin auth callback <complete-callback-url>
  furet plugin auth status
  furet plugin auth logout <gitea-url>

A plugin package must declare this in package.json:
  "furet": { "plugin": "./dist/index.js" }

Commands update config.yaml but never restart the gateway automatically.`);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

const args = process.argv.slice(3);
const action = args.shift();

try {
  switch (action) {
    case "install": {
      const workspace = option(args, "--workspace");
      const source = args.shift();
      if (!source || args.length) usage();
      console.log(await installPlugin(source, { workspace }));
      break;
    }
    case "list":
      if (args.length) usage();
      console.log(listPlugins());
      break;
    case "enable":
    case "disable": {
      const name = args.shift();
      if (!name || args.length) usage();
      console.log(setManagedPluginEnabled(name, action === "enable"));
      break;
    }
    case "update": {
      const name = args.shift();
      if (args.length) usage();
      console.log(await updatePlugins(name));
      break;
    }
    case "remove": {
      const name = args.shift();
      if (!name || args.length) usage();
      console.log(removeManagedPlugin(name));
      break;
    }
    case "auth": {
      const authAction = args.shift();
      const ownerId = loadConfig().discord.owner_id || "cli-owner";
      switch (authAction) {
        case "login": {
          const clientId = option(args, "--client-id");
          const redirectUri = option(args, "--redirect-uri");
          const host = args.shift();
          if (!host || args.length) usage();
          console.log(beginGiteaPluginAuth(host, ownerId, { clientId, redirectUri }).instructions);
          break;
        }
        case "callback": {
          const callback = args.shift();
          if (!callback || args.length) usage();
          console.log(await completeGiteaPluginAuth(callback, ownerId));
          break;
        }
        case "status":
          if (args.length) usage();
          console.log(listPluginGitAuth());
          break;
        case "logout": {
          const host = args.shift();
          if (!host || args.length) usage();
          console.log(removePluginGitAuth(host));
          break;
        }
        default:
          usage();
      }
      break;
    }
    default:
      usage();
  }
} catch (error) {
  console.error(`Plugin command failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
