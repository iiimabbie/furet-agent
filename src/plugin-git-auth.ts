import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PLUGIN_GIT_AUTH_FILE } from "./paths.js";

const DEFAULT_GITEA_CLIENT_ID = "a4792ccc-144e-407e-86c9-5e7d8d9c3269";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1";
const DEFAULT_SCOPE = "read:repository";
const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;

interface PendingAuthorization {
  state: string;
  ownerId: string;
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeVerifier: string;
  expiresAt: number;
}

interface GitOAuthConnection {
  provider: "gitea";
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  connectedAt: string;
}

interface GitAuthStore {
  version: 1;
  pending: PendingAuthorization[];
  connections: GitOAuthConnection[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

const EMPTY_STORE: GitAuthStore = { version: 1, pending: [], connections: [] };

function readStore(): GitAuthStore {
  if (!existsSync(PLUGIN_GIT_AUTH_FILE)) return structuredClone(EMPTY_STORE);
  try {
    const parsed = JSON.parse(readFileSync(PLUGIN_GIT_AUTH_FILE, "utf8")) as Partial<GitAuthStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.pending) || !Array.isArray(parsed.connections)) {
      throw new Error("unsupported auth store format");
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

function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Gitea host must use http:// or https://");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Gitea host must not contain credentials, query parameters, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeRedirectUri(input?: string): string {
  const url = new URL((input || DEFAULT_REDIRECT_URI).trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OAuth redirect URI must use http:// or https://");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OAuth redirect URI must not contain credentials, query parameters, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

function prunePending(store: GitAuthStore): void {
  const now = Date.now();
  store.pending = store.pending.filter(item => item.expiresAt > now);
}

export function beginGiteaPluginAuth(
  host: string,
  ownerId: string,
  options: { clientId?: string; redirectUri?: string } = {},
): string {
  const baseUrl = normalizeBaseUrl(host);
  const clientId = options.clientId?.trim() || DEFAULT_GITEA_CLIENT_ID;
  const redirectUri = normalizeRedirectUri(options.redirectUri);
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = base64url(randomBytes(32));
  const scope = DEFAULT_SCOPE;

  const store = readStore();
  prunePending(store);
  store.pending = store.pending.filter(item => !(item.ownerId === ownerId && item.baseUrl === baseUrl));
  store.pending.push({
    state,
    ownerId,
    baseUrl,
    clientId,
    redirectUri,
    scope,
    codeVerifier,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  writeStore(store);

  const url = new URL(endpoint(baseUrl, "/login/oauth/authorize"));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", codeChallenge);

  return [
    `Open this Gitea authorization URL:\n${url.toString()}`,
    "",
    `After approval, the browser may show that ${redirectUri} cannot be reached. Copy the complete URL from the address bar and submit it with:`,
    "`/plugin auth callback url:<complete callback URL>`",
    "",
    "This authorization request expires in 10 minutes.",
  ].join("\n");
}

async function requestToken(baseUrl: string, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(endpoint(baseUrl, "/login/oauth/access_token"), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload: TokenResponse;
  try {
    payload = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Gitea token endpoint returned ${response.status} with a non-JSON response`);
  }
  if (!response.ok || payload.error || !payload.access_token) {
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Gitea OAuth token exchange failed: ${detail}`);
  }
  return payload;
}

function callbackMatchesRedirect(callback: URL, redirectUri: string): boolean {
  const expected = new URL(redirectUri);
  return callback.protocol === expected.protocol
    && callback.hostname === expected.hostname
    && callback.port === expected.port
    && callback.pathname === expected.pathname;
}

export async function completeGiteaPluginAuth(callbackUrl: string, ownerId: string): Promise<string> {
  const callback = new URL(callbackUrl.trim());
  const state = callback.searchParams.get("state");
  const code = callback.searchParams.get("code");
  const oauthError = callback.searchParams.get("error");
  if (!state) throw new Error("Callback URL does not contain state");

  const store = readStore();
  prunePending(store);
  const index = store.pending.findIndex(item => item.state === state && item.ownerId === ownerId);
  if (index < 0) {
    writeStore(store);
    throw new Error("Authorization request is missing, expired, or belongs to another owner");
  }
  const [pending] = store.pending.splice(index, 1);
  writeStore(store); // State is single-use even when the provider returned an error.

  if (!callbackMatchesRedirect(callback, pending.redirectUri)) {
    throw new Error("Callback URL does not match the redirect URI used to start authorization");
  }
  if (oauthError) {
    throw new Error(`Gitea authorization failed: ${callback.searchParams.get("error_description") || oauthError}`);
  }
  if (!code) throw new Error("Callback URL does not contain an authorization code");

  const token = await requestToken(pending.baseUrl, new URLSearchParams({
    client_id: pending.clientId,
    code,
    grant_type: "authorization_code",
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier,
  }));

  const latest = readStore();
  prunePending(latest);
  latest.connections = latest.connections.filter(item => item.baseUrl !== pending.baseUrl);
  latest.connections.push({
    provider: "gitea",
    baseUrl: pending.baseUrl,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    scope: token.scope || pending.scope,
    accessToken: token.access_token!,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(typeof token.expires_in === "number" ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
    connectedAt: new Date().toISOString(),
  });
  writeStore(latest);
  return `Connected Gitea OAuth for ${pending.baseUrl}. HTTPS plugin install and update will use it automatically.`;
}

async function refreshConnection(connection: GitOAuthConnection): Promise<GitOAuthConnection> {
  if (!connection.expiresAt || connection.expiresAt - Date.now() > REFRESH_SKEW_MS) return connection;
  if (!connection.refreshToken) {
    throw new Error(`OAuth access for ${connection.baseUrl} expired and has no refresh token; run /plugin auth login again`);
  }
  const token = await requestToken(connection.baseUrl, new URLSearchParams({
    client_id: connection.clientId,
    refresh_token: connection.refreshToken,
    grant_type: "refresh_token",
  }));
  return {
    ...connection,
    accessToken: token.access_token!,
    refreshToken: token.refresh_token || connection.refreshToken,
    scope: token.scope || connection.scope,
    ...(typeof token.expires_in === "number" ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
  };
}

function connectionMatchesSource(connection: GitOAuthConnection, source: URL): boolean {
  const base = new URL(connection.baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  return source.origin === base.origin
    && (basePath === "" || source.pathname === basePath || source.pathname.startsWith(`${basePath}/`));
}

export async function gitOAuthEnvironment(source: string): Promise<NodeJS.ProcessEnv> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return {};
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return {};

  const store = readStore();
  const index = store.connections.findIndex(item => connectionMatchesSource(item, url));
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
    GIT_CONFIG_VALUE_1: "!f() { test \"$1\" = get || exit 0; echo \"username=$FURET_GIT_OAUTH_TOKEN\"; echo 'password=x-oauth-basic'; }; f",
  };
}

export function listPluginGitAuth(): string {
  const store = readStore();
  prunePending(store);
  writeStore(store);
  if (!store.connections.length) return "No plugin Git OAuth connections.";
  return store.connections.map(item => {
    const expiry = item.expiresAt ? new Date(item.expiresAt).toISOString() : "unknown";
    return `${item.provider} — ${item.baseUrl} — scope: ${item.scope || "default"} — access expires: ${expiry}`;
  }).join("\n");
}

export function removePluginGitAuth(host: string): string {
  const baseUrl = normalizeBaseUrl(host);
  const store = readStore();
  const before = store.connections.length;
  store.connections = store.connections.filter(item => item.baseUrl !== baseUrl);
  store.pending = store.pending.filter(item => item.baseUrl !== baseUrl);
  if (store.connections.length === before) throw new Error(`No plugin Git OAuth connection for ${baseUrl}`);
  writeStore(store);
  return `Removed plugin Git OAuth connection for ${baseUrl}.`;
}
