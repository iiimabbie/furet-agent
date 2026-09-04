#!/usr/bin/env -S npx tsx
import { resolve } from "node:path";

const command = process.argv[2];

switch (command) {
  case "gateway":
    await import(resolve(import.meta.dirname!, "../src/gateway.ts"));
    break;
  case "onbord":
    await import(resolve(import.meta.dirname!, "../src/onboarding-cli.ts"));
    break;
  case "install":
    await import(resolve(import.meta.dirname!, "../src/install.ts"));
    break;
  case "plugin":
    await import(resolve(import.meta.dirname!, "../src/plugin-cli.ts"));
    break;
  default:
    await import(resolve(import.meta.dirname!, "../src/cli.ts"));
    break;
}
