import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { logger } from "../utils/logger.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const SCOPE = "openid profile email offline_access";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const AUTH_CLAIM = "https://api.openai.com/auth";
const AUTH_PATH = resolve(process.cwd(), "data", "codex-device-auth.json");
const REFRESH_SKEW_MS = 60_000;
const CALLBACK_PORT = 1455;
const CALLBACK_SERVER_TIMEOUT_MS = 10 * 60_000;
const ORIGINATOR = "opencode";
const OPENCODE_USER_AGENT = "opencode/1.15.7";
const CODEX_DEFAULT_INSTRUCTIONS = "You are Codex. Follow the user's instructions exactly.";

const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`;

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "Accept": "application/json, text/plain, */*",
  "User-Agent": OPENCODE_USER_AGENT,
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/plain, */*",
  "User-Agent": OPENCODE_USER_AGENT,
};

type TokenResult = {
  idToken?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
};

type DeviceCodeResponse = {
  device_auth_id: string;
  user_code: string;
  interval: string | number;
  expires_at?: string;
};

type DeviceTokenResponse = {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
};

type PendingDeviceCode = {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
};

let pendingDeviceCode: PendingDeviceCode | null = null;
let deviceCodePollingTimer: ReturnType<typeof setInterval> | null = null;

type StoredToken = TokenResult & {
  updatedAt: string;
};

type PendingFlow = {
  verifier: string;
  state: string;
  authorizationUrl: string;
  redirectUri: string;
  createdAt: number;
};

let pendingFlow: PendingFlow | null = null;
let callbackServer: Server | null = null;
let callbackServerTimer: ReturnType<typeof setTimeout> | null = null;

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[AUTH_CLAIM];
  if (!auth || typeof auth !== "object") return null;
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId : null;
}

function extractJwtExpiry(token: string | undefined): number | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

function parseDeviceInterval(value: string | number | undefined): number {
  const interval = typeof value === "number" ? value : Number(value ?? 5);
  return Number.isFinite(interval) && interval > 0 ? interval : 5;
}

function parseDeviceExpiresAt(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now() + 15 * 60_000;
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL.
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

async function readStoredToken(): Promise<StoredToken | null> {
  try {
    const raw = await readFile(AUTH_PATH, "utf8");
    const token = JSON.parse(raw) as StoredToken;
    if (!token.accessToken || !token.refreshToken || !token.accountId || !Number.isFinite(token.expiresAt)) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

async function writeStoredToken(token: TokenResult): Promise<void> {
  await mkdir(dirname(AUTH_PATH), { recursive: true });
  await writeFile(AUTH_PATH, JSON.stringify({ ...token, updatedAt: new Date().toISOString() }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function exchangeToken(params: URLSearchParams): Promise<TokenResult> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: FORM_HEADERS,
    body: params,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Codex OAuth token exchange failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json() as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new Error("Codex OAuth token response missing required fields");
  }

  const accountId = extractAccountId(json.access_token) ?? extractAccountId(json.id_token ?? "");
  if (!accountId) {
    throw new Error("Codex OAuth access token does not include a ChatGPT account id");
  }

  const expiresAt = typeof json.expires_in === "number"
    ? Date.now() + json.expires_in * 1000
    : extractJwtExpiry(json.access_token) ?? extractJwtExpiry(json.id_token) ?? Date.now() + 60 * 60_000;

  return {
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt,
    accountId,
  };
}

async function refreshStoredToken(token: StoredToken): Promise<StoredToken> {
  const refreshed = await exchangeToken(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: CLIENT_ID,
  }));
  await writeStoredToken(refreshed);
  return { ...refreshed, updatedAt: new Date().toISOString() };
}

async function getUsableToken(): Promise<StoredToken> {
  const token = await readStoredToken();
  if (!token) {
    throw new Error("Codex device auth is not logged in. Start and complete Codex OAuth login first.");
  }
  if (token.expiresAt <= Date.now() + REFRESH_SKEW_MS) {
    return refreshStoredToken(token);
  }
  return token;
}

function isStreamingRequest(init: RequestInit | undefined): boolean {
  try {
    if (!init?.body || typeof init.body !== "string") return false;
    const body = JSON.parse(init.body) as { stream?: unknown };
    return body.stream === true;
  } catch {
    return false;
  }
}

function ensureCodexInstructions(url: string, body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (!url.includes("/backend-api/codex/responses") || typeof body !== "string") {
    return body;
  }

  try {
    const parsed = JSON.parse(body) as { instructions?: unknown; store?: unknown };
    const instructions = typeof parsed.instructions === "string" && parsed.instructions.trim()
      ? parsed.instructions
      : CODEX_DEFAULT_INSTRUCTIONS;

    if (parsed.instructions === instructions && parsed.store === false) {
      return body;
    }

    return JSON.stringify({
      ...parsed,
      instructions,
      store: false,
      stream: true,
    });
  } catch {
    return body;
  }
}

async function convertSseToJson(response: Response): Promise<Response> {
  const text = await response.text();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      const data = JSON.parse(line.slice(6)) as { type?: string; response?: unknown };
      if ((data.type === "response.done" || data.type === "response.completed") && data.response) {
        const headers = new Headers(response.headers);
        headers.set("content-type", "application/json; charset=utf-8");
        return new Response(JSON.stringify(data.response), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    } catch {
      // Ignore malformed SSE events.
    }
  }
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function codexDeviceFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
  const token = await getUsableToken();
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const parsedUrl = new URL(requestUrl);
  const url = parsedUrl.pathname.includes("/responses") || parsedUrl.pathname.includes("/chat/completions")
    ? `${CODEX_BASE_URL}/codex/responses`
    : requestUrl;
  const headers = new Headers(init?.headers ?? {});

  headers.delete("authorization");
  headers.delete("Authorization");
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${token.accessToken}`);
  headers.set("ChatGPT-Account-Id", token.accountId);
  headers.set("originator", ORIGINATOR);
  headers.set("User-Agent", `${OPENCODE_USER_AGENT} (${process.platform}; ${process.arch})`);

  const originalStreaming = isStreamingRequest(init);
  const body = ensureCodexInstructions(url, init?.body);
  if (originalStreaming || url.includes("/backend-api/codex/responses")) {
    headers.set("accept", "text/event-stream");
  }

  const response = await fetch(url, { ...init, headers, body });
  if (!response.ok || originalStreaming) return response;

  if (url.includes("/backend-api/codex/responses")) {
    return convertSseToJson(response);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return convertSseToJson(response);
  }
  return response;
}

function stopCallbackServer(): void {
  if (callbackServerTimer) {
    clearTimeout(callbackServerTimer);
    callbackServerTimer = null;
  }
  if (callbackServer) {
    try { callbackServer.close(); } catch { /* ignore */ }
    callbackServer = null;
    logger.info("codex-callback-server-stopped");
  }
}

function buildCallbackHtml(success: boolean, message: string): string {
  const color = success ? "#10b981" : "#ef4444";
  const icon = success ? "✅" : "❌";
  const title = success ? "Codex Auth สำเร็จ!" : "Codex Auth ล้มเหลว";
  return `<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif}
  .card{text-align:center;padding:3rem 2rem;border-radius:1.5rem;border:1px solid ${color}33;background:${color}0a;max-width:420px}
  .icon{font-size:3rem;margin-bottom:1rem}
  h1{font-size:1.5rem;color:${color};margin:0 0 0.75rem}
  p{color:#94a3b8;font-size:0.9rem;line-height:1.6;margin:0}
  .hint{margin-top:1.5rem;font-size:0.8rem;color:#64748b}
</style></head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <p class="hint">แท็บนี้จะปิดอัตโนมัติใน 3 วินาที...</p>
</div>
<script>setTimeout(()=>window.close(),3000)</script>
</body></html>`;
}

async function startCallbackServer(): Promise<void> {
  stopCallbackServer();

  return new Promise<void>((resolveStart, rejectStart) => {
    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url || "/", `http://localhost:${CALLBACK_PORT}`);
      if (reqUrl.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const fullCallbackUrl = `http://localhost:${CALLBACK_PORT}${req.url}`;
      try {
        await completeCodexBrowserAuth(fullCallbackUrl);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildCallbackHtml(true, "LINE image OCR พร้อมใช้ codex-device แล้ว กลับไปหน้า Settings ได้เลย"));
        logger.info("codex-callback-auto-completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildCallbackHtml(false, message));
        logger.error("codex-callback-auto-complete-failed", { error: message });
      } finally {
        setTimeout(() => stopCallbackServer(), 2000);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      callbackServer = server;
      logger.info("codex-callback-server-started", { port: CALLBACK_PORT });
      resolveStart();
    });

    server.on("error", (err) => {
      logger.warn("codex-callback-server-failed", { error: (err as Error).message });
      // Non-fatal: user can still paste URL manually via Complete button
      resolveStart();
    });

    // Auto-close after 10 minutes (matches pendingFlow expiry)
    callbackServerTimer = setTimeout(() => stopCallbackServer(), CALLBACK_SERVER_TIMEOUT_MS);
  });
}

export function stopDeviceCodePolling(): void {
  if (deviceCodePollingTimer) {
    clearInterval(deviceCodePollingTimer);
    deviceCodePollingTimer = null;
  }
  pendingDeviceCode = null;
}

function startDeviceCodePolling(): void {
  if (!pendingDeviceCode) return;
  const intervalMs = Math.max(pendingDeviceCode.interval, 5) * 1000;

  deviceCodePollingTimer = setInterval(async () => {
    if (!pendingDeviceCode) {
      stopDeviceCodePolling();
      return;
    }

    if (Date.now() >= pendingDeviceCode.expiresAt) {
      logger.warn("codex-device-code-expired");
      stopDeviceCodePolling();
      return;
    }

    try {
      const response = await fetch(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          device_auth_id: pendingDeviceCode.deviceAuthId,
          user_code: pendingDeviceCode.userCode,
        }),
      });

      if (response.ok) {
        const json = await response.json() as Partial<DeviceTokenResponse>;
        if (!json.authorization_code || !json.code_verifier) {
          throw new Error("Device auth token response missing authorization code fields");
        }

        const token = await exchangeToken(new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: json.authorization_code,
          code_verifier: json.code_verifier,
          redirect_uri: DEVICE_REDIRECT_URI,
        }));

        await writeStoredToken(token);

        logger.info("codex-device-code-auth-success");
        stopDeviceCodePolling();
        return;
      }

      if (response.status === 403 || response.status === 404) {
        return;
      }

      const body = await response.text().catch(() => "");
      logger.error("codex-device-code-auth-poll-error", { status: response.status, error: body.slice(0, 200) });
    } catch (error) {
      logger.error("codex-device-code-auth-poll-exception", { error: String(error) });
    }
  }, intervalMs);
}

export async function startDeviceCodeAuth(): Promise<{
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}> {
  stopDeviceCodePolling();
  stopCallbackServer();
  pendingFlow = null;

  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to start device code auth (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json() as DeviceCodeResponse;
  if (!json.device_auth_id || !json.user_code) {
    throw new Error("Device code response missing required fields");
  }

  const expiresAt = parseDeviceExpiresAt(json.expires_at);

  pendingDeviceCode = {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    verificationUri: DEVICE_VERIFICATION_URL,
    interval: parseDeviceInterval(json.interval),
    expiresAt,
  };

  startDeviceCodePolling();

  return {
    userCode: json.user_code,
    verificationUri: DEVICE_VERIFICATION_URL,
    expiresIn: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  };
}

export async function startCodexBrowserAuth(): Promise<{ authorizationUrl: string; state: string; redirectUri: string }> {
  stopDeviceCodePolling();
  pendingFlow = null;

  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(16).toString("hex");
  const redirectUri = REDIRECT_URI;
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", ORIGINATOR);

  pendingFlow = {
    verifier,
    state,
    authorizationUrl: url.toString(),
    redirectUri,
    createdAt: Date.now(),
  };

  await startCallbackServer();

  return { authorizationUrl: pendingFlow.authorizationUrl, state, redirectUri };
}

export async function completeCodexBrowserAuth(input: string): Promise<{ authenticated: true; expiresAt: number }> {
  if (!pendingFlow) {
    throw new Error("No pending Codex OAuth flow. Start login first.");
  }
  if (pendingFlow.createdAt < Date.now() - 10 * 60_000) {
    pendingFlow = null;
    throw new Error("Pending Codex OAuth flow expired. Start login again.");
  }

  const parsed = parseAuthorizationInput(input);
  if (!parsed.code) {
    throw new Error("Authorization callback did not include a code.");
  }
  if (parsed.state && parsed.state !== pendingFlow.state) {
    throw new Error("Authorization state did not match the pending flow.");
  }

  const token = await exchangeToken(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: parsed.code,
    code_verifier: pendingFlow.verifier,
    redirect_uri: pendingFlow.redirectUri,
  }));
  await writeStoredToken(token);
  pendingFlow = null;
  return { authenticated: true, expiresAt: token.expiresAt };
}


export async function getCodexDeviceAuthStatus(): Promise<{
  authenticated: boolean;
  hasPendingFlow: boolean;
  hasPendingDeviceCode: boolean;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  accountIdSuffix?: string;
  authPath: string;
}> {
  const token = await readStoredToken();
  return {
    authenticated: Boolean(token),
    hasPendingFlow: Boolean(pendingFlow),
    hasPendingDeviceCode: Boolean(pendingDeviceCode),
    userCode: pendingDeviceCode?.userCode,
    verificationUri: pendingDeviceCode?.verificationUri,
    expiresAt: token?.expiresAt,
    accountIdSuffix: token?.accountId.slice(-6),
    authPath: AUTH_PATH,
  };
}

export async function clearCodexDeviceAuth(): Promise<void> {
  pendingFlow = null;
  stopCallbackServer();
  stopDeviceCodePolling();
  if (existsSync(AUTH_PATH)) {
    await rm(AUTH_PATH, { force: true });
  }
}

export function codexDeviceModel(modelId: string): LanguageModelV3 {
  const provider = createOpenAI({
    name: "codex-device",
    apiKey: "chatgpt-oauth",
    baseURL: CODEX_BASE_URL,
    fetch: codexDeviceFetch,
  });
  return provider.responses(modelId);
}

export async function hasCodexDeviceAuth(): Promise<boolean> {
  return Boolean(await readStoredToken());
}
