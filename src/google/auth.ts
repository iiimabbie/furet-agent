import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { GOOGLE_TOKEN_PATH } from "../paths.js";
import { logger } from "../logger.js";

const REDIRECT_URI = "http://127.0.0.1";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/tasks",
];

function createOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

let cachedClient: InstanceType<typeof google.auth.OAuth2> | null = null;

export function getAuthClient(): InstanceType<typeof google.auth.OAuth2> | null {
  if (cachedClient) return cachedClient;
  if (!existsSync(GOOGLE_TOKEN_PATH)) return null;

  try {
    const tokens = JSON.parse(readFileSync(GOOGLE_TOKEN_PATH, "utf-8"));
    const client = createOAuth2Client();
    if (!client) return null;
    client.setCredentials(tokens);

    client.on("tokens", (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      writeFileSync(GOOGLE_TOKEN_PATH, JSON.stringify(merged, null, 2));
      logger.info("google token refreshed and saved");
    });

    cachedClient = client;
    return client;
  } catch (err) {
    logger.error({ err }, "failed to load google token");
    return null;
  }
}

export function getAuthUrl(): string | null {
  const client = createOAuth2Client();
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

function extractCode(input: string): string {
  try {
    const url = new URL(input);
    return url.searchParams.get("code") ?? input;
  } catch {
    return input;
  }
}

export async function exchangeCode(input: string): Promise<void> {
  const code = extractCode(input);
  const client = createOAuth2Client();
  if (!client) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 未設定");
  const { tokens } = await client.getToken(code);
  writeFileSync(GOOGLE_TOKEN_PATH, JSON.stringify(tokens, null, 2));
  client.setCredentials(tokens);

  client.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync(GOOGLE_TOKEN_PATH, JSON.stringify(merged, null, 2));
    logger.info("google token refreshed and saved");
  });

  cachedClient = client;
  logger.info("google oauth authorized and token saved");
}
