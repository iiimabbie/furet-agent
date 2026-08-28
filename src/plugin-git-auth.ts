import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PLUGIN_GIT_AUTH_FILE } from "./paths.js";

const GITHUB_BASE_URL = "https://github.com";
const GITHUB_API_URL = "https://api.github.com";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const REFRESH_SKEW_MS = 60 * 1000;

interface PendingAuthorization {
  provider: "github";
  ownerId: string;
  clientId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
  lastPolledAt?: number;
}

interface GitOAuthConnection {
  provider: "github";
  baseUrl: typeof GITHUB_BASE_URL;
  clientId: string;
  account: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  connectedAt: string;
}

interface GitAuthStore {
  version: 2;
  pending: PendingAuthorization[];
  connections: GitOAuthConnection[];
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

const EMPTY_STORE: GitAuthStore = { version: 2, pending: [], connections: [] };

function readStore(): GitAuthStore {
  if (!existsSync(PLUGIN_GIT_AUTH_FILE)) return structuredClone(EMPTY_STORE);
  try {
    const parsed = JSON.parse(readFileSync(PLUGIN_GIT_AUTH_FILE, "utf8")) as Partial<GitAuthStore>;
    if (parsed.version !== 2 || !Array.isArray(parsed.pending) || !Array.isArray(parsed.connections)) {
      return structuredClone(EMPTY_STORE);
    }
    return parsed as GitAuthStore;
  } catch (error) {
    throw new Error(`Cannot read plugin Git auth store: ${(error as Error).message}`);
  }
}

function writeStore(store: GitAuthStore): void {
  mkdirSync(dirname(PLUGIN_GIT_AUTH_FILE), { recursive: true });
  const temp = `${PLUGIN_GIT_AUTH_FILE}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, PLUGIN_GIT_AUTH_FILE);
}

function githubClientId(override?: string): string {
  const clientId = override?.trim() || process.env.GITHUB_APP_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("GitHub authorization is not configured. Set GITHUB_APP_CLIENT_ID to a GitHub App client ID with Device Flow enabled, then restart Furet.");
  }
  return clientId;
}

function prunePending(store: GitAuthStore): void {
  const now = Date.now();
  store.pending = store.pending.filter(item => item.expiresAt > now);
}

async function postGitHub<T>(path: string, body: URLSearchParams): Promise<T> {
  const response = await fetch(`${GITHUB_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Furet",
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload: T;
  try {
    payload = JSON.parse(text) as T;
  } catch {
    throw new Error(`GitHub OAuth endpoint returned ${response.status} with a non-JSON response`);
  }
  if (!response.ok) throw new Error(`GitHub OAuth request failed with HTTP ${response.status}`);
  return payload;
}

export interface GitHubPluginAuthStart {
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  instructions: string;
  installationUrl?: string;
}

export async function beginGitHubPluginAuth(
  ownerId: string,
  options: { clientId?: string } = {},
): Promise<GitHubPluginAuthStart> {
  const clientId = githubClientId(options.clientId);
  const response = await postGitHub<DeviceCodeResponse>("/login/device/code", new URLSearchParams({
    client_id: clientId,
  }));
  if (response.error || !response.device_code || !response.user_code || !response.verification_uri) {
    const detail = response.error_description || response.error || "invalid device-code response";
    throw new Error(`GitHub device authorization failed: ${detail}`);
  }

  const expiresAt = Date.now() + (response.expires_in ?? 900) * 1000;
  const store = readStore();
  prunePending(store);
  store.pending = store.pending.filter(item => item.ownerId !== ownerId);
  store.pending.push({
    provider: "github",
    ownerId,
    clientId,
    deviceCode: response.device_code,
    userCode: response.user_code,
    verificationUri: response.verification_uri,
    expiresAt,
    intervalSeconds: Math.max(response.interval ?? DEFAULT_POLL_INTERVAL_SECONDS, 1),
  });
  writeStore(store);

  const appSlug = process.env.GITHUB_APP_SLUG?.trim();
  return {
    verificationUri: response.verification_uri,
    userCode: response.user_code,
    expiresAt,
    ...(appSlug ? { installationUrl: `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new` } : {}),
    instructions: [
      `Open ${response.verification_uri}`,
      `Enter code: ${response.user_code}`,
      "After GitHub approves the request, return and complete authorization.",
    ].join("\n"),
  };
}

async function githubAccount(accessToken: string): Promise<string> {
  const response = await fetch(`${GITHUB_API_URL}/user`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "Furet",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub identity check failed with HTTP ${response.status}`);
  const payload = await response.json() as { login?: string };
  if (!payload.login) throw new Error("GitHub identity response did not contain a login");
  return payload.login;
}

export async function completeGitHubPluginAuth(ownerId: string): Promise<string> {
  const store = readStore();
  prunePending(store);
  const index = store.pending.findIndex(item => item.ownerId === ownerId);
  if (index < 0) {
    writeStore(store);
    throw new Error("GitHub authorization request is missing or expired; start authorization again");
  }

  const pending = store.pending[index];
  const minimumPollAt = (pending.lastPolledAt ?? 0) + pending.intervalSeconds * 1000;
  if (Date.now() < minimumPollAt) {
    const seconds = Math.ceil((minimumPollAt - Date.now()) / 1000);
    throw new Error(`GitHub is still processing the authorization; wait ${seconds} seconds and try again`);
  }
  pending.lastPolledAt = Date.now();
  writeStore(store);

  const token = await postGitHub<TokenResponse>("/login/oauth/access_token", new URLSearchParams({
    client_id: pending.clientId,
    device_code: pending.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  }));

  if (token.error === "authorization_pending") {
    throw new Error("GitHub authorization is not complete yet. Finish it in the browser, then press the button again");
  }
  if (token.error === "slow_down") {
    const latest = readStore();
    const current = latest.pending.find(item => item.ownerId === ownerId);
    if (current) {
      current.intervalSeconds += 5;
      writeStore(latest);
    }
    throw new Error("GitHub asked Furet to slow down. Wait a few seconds, then press the button again");
  }
  if (token.error || !token.access_token) {
    const latest = readStore();
    latest.pending = latest.pending.filter(item => item.ownerId !== ownerId);
    writeStore(latest);
    const detail = token.error_description || token.error || "invalid token response";
    throw new Error(`GitHub authorization failed: ${detail}`);
  }

  const account = await githubAccount(token.access_token);
  const latest = readStore();
  prunePending(latest);
  latest.pending = latest.pending.filter(item => item.ownerId !== ownerId);
  latest.connections = latest.connections.filter(item => item.provider !== "github");
  latest.connections.push({
    provider: "github",
    baseUrl: GITHUB_BASE_URL,
    clientId: pending.clientId,
    account,
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(typeof token.expires_in === "number" ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
    ...(typeof token.refresh_token_expires_in === "number"
      ? { refreshTokenExpiresAt: Date.now() + token.refresh_token_expires_in * 1000 }
      : {}),
    connectedAt: new Date().toISOString(),
  });
  writeStore(latest);
  return `Connected GitHub account ${account}. Private HTTPS plugin install and update will use it automatically.`;
}

async function refreshConnection(connection: GitOAuthConnection): Promise<GitOAuthConnection> {
  if (!connection.expiresAt || connection.expiresAt - Date.now() > REFRESH_SKEW_MS) return connection;
  if (!connection.refreshToken || (connection.refreshTokenExpiresAt && connection.refreshTokenExpiresAt <= Date.now())) {
    throw new Error("GitHub OAuth expired; authorize GitHub again with /plugin action:auth");
  }
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new Error("GitHub token expired. Reauthorize, or configure GITHUB_APP_CLIENT_SECRET so Furet can refresh expiring user tokens");
  }
  const token = await postGitHub<TokenResponse>("/login/oauth/access_token", new URLSearchParams({
    client_id: connection.clientId,
    client_secret: clientSecret,
    refresh_token: connection.refreshToken,
    grant_type: "refresh_token",
  }));
  if (token.error || !token.access_token) {
    const detail = token.error_description || token.error || "invalid refresh response";
    throw new Error(`GitHub OAuth refresh failed: ${detail}`);
  }
  return {
    ...connection,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || connection.refreshToken,
    ...(typeof token.expires_in === "number" ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
    ...(typeof token.refresh_token_expires_in === "number"
      ? { refreshTokenExpiresAt: Date.now() + token.refresh_token_expires_in * 1000 }
      : {}),
  };
}

export async function gitOAuthEnvironment(source: string): Promise<NodeJS.ProcessEnv> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return {};
  }
  if (url.protocol !== "https:" || url.origin !== GITHUB_BASE_URL) return {};

  const store = readStore();
  const index = store.connections.findIndex(item => item.provider === "github");
  if (index < 0) return {};
  const refreshed = await refreshConnection(store.connections[index]);
  if (refreshed !== store.connections[index]) {
    store.connections[index] = refreshed;
    writeStore(store);
  }

  return {
    FURET_GIT_OAUTH_TOKEN: refreshed.accessToken,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "!f() { test \"$1\" = get || exit 0; echo 'username=x-access-token'; echo \"password=$FURET_GIT_OAUTH_TOKEN\"; }; f",
  };
}

export function listPluginGitAuth(): string {
  const store = readStore();
  prunePending(store);
  writeStore(store);
  const connection = store.connections.find(item => item.provider === "github");
  if (!connection) return "GitHub is not connected.";
  const expiry = connection.expiresAt ? new Date(connection.expiresAt).toISOString() : "does not expire";
  return `GitHub — ${connection.account} — GitHub App permissions — access expires: ${expiry}`;
}

export function removePluginGitAuth(): string {
  const store = readStore();
  const hadConnection = store.connections.some(item => item.provider === "github");
  store.connections = store.connections.filter(item => item.provider !== "github");
  store.pending = store.pending.filter(item => item.provider !== "github");
  if (!hadConnection) throw new Error("GitHub is not connected");
  writeStore(store);
  return "Removed the locally stored GitHub authorization. You can also revoke the Furet GitHub App from GitHub settings.";
}
