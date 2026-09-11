import { createHash, randomBytes } from "node:crypto";
import { CookieJar, type Cookie } from "tough-cookie";
import type {
  ProviderAuthErrorCode,
  ProviderCredentials,
  ProviderSession,
} from "../../models/provider-auth.js";

const ACCOUNTS_ORIGIN = "https://accounts.myagencyservice.in.th";
const LOGISTICS_ORIGIN = "https://logistics.myagencyservice.in.th";
const IDENTITY_PATH = "/api/basicserver/agency/account/current_user/basic_info";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_SESSION_COOKIE_BYTES = 2_800;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const ALLOWED_ORIGINS = new Set([ACCOUNTS_ORIGIN, LOGISTICS_ORIGIN]);

type FetchImplementation = typeof fetch;

export interface ProviderAuthClientOptions {
  deviceId?: string;
  signal?: AbortSignal;
  fetch?: FetchImplementation;
}

export interface ProviderSessionCheckOptions {
  signal?: AbortSignal;
  fetch?: FetchImplementation;
}

export type ProviderSessionCheck =
  | { status: "valid" }
  | { status: "expired"; errorCode: "session_expired" }
  | {
      status: "unavailable";
      errorCode: Exclude<ProviderAuthErrorCode, "session_expired">;
      retryAfterMs: number | null;
    };

export class ProviderAuthError extends Error {
  readonly code: ProviderAuthErrorCode;
  readonly retryAfterMs: number | null;

  constructor(code: ProviderAuthErrorCode, retryAfterMs: number | null = null) {
    super(code);
    this.name = "ProviderAuthError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deadlineSignal(external?: AbortSignal): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      if (!controller.signal.aborted) controller.abort();
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  };
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the safe protocol error selected by the caller.
  }
}

function validateAllowedUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderAuthError("invalid_response");
  }
  if (url.protocol !== "https:" || !ALLOWED_ORIGINS.has(url.origin)) {
    throw new ProviderAuthError("invalid_response");
  }
  return url;
}

function parseRetryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  const milliseconds = /^\d+$/.test(value)
    ? Number(value) * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  return Math.min(milliseconds, MAX_RETRY_AFTER_MS);
}

function statusError(response: Response): ProviderAuthError {
  if (response.status === 429) {
    return new ProviderAuthError("rate_limited", parseRetryAfter(response));
  }
  if (response.status === 403 || response.status >= 500) {
    return new ProviderAuthError("provider_unavailable", parseRetryAfter(response));
  }
  if (response.status === 401) return new ProviderAuthError("invalid_credentials");
  return new ProviderAuthError("invalid_response");
}

async function boundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await discardResponse(response);
    throw new ProviderAuthError("invalid_response");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProviderAuthError("invalid_response");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await boundedText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderAuthError("invalid_response");
  }
}

function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

async function storeResponseCookies(jar: CookieJar, response: Response, url: URL): Promise<void> {
  for (const cookie of getSetCookieHeaders(response)) {
    try {
      await jar.setCookie(cookie, url.href);
    } catch {
      throw new ProviderAuthError("invalid_response");
    }
  }
}

async function jarRequest(
  jar: CookieJar,
  fetchImplementation: FetchImplementation,
  input: string | URL,
  init: RequestInit,
  signal: AbortSignal,
  followRedirects = false,
): Promise<{ response: Response; url: URL }> {
  let url = validateAllowedUrl(input);
  let requestInit = { ...init };
  for (let redirects = 0; ; redirects += 1) {
    const headers = new Headers(requestInit.headers);
    const cookie = await jar.getCookieString(url.href);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetchImplementation(url.href, {
      ...requestInit,
      headers,
      signal,
      redirect: "manual",
    });
    await storeResponseCookies(jar, response, url);

    if (response.status < 300 || response.status >= 400) return { response, url };
    await discardResponse(response);
    if (!followRedirects || redirects >= MAX_REDIRECTS) {
      throw new ProviderAuthError("invalid_response");
    }
    const location = response.headers.get("location");
    if (!location) throw new ProviderAuthError("invalid_response");
    url = validateAllowedUrl(new URL(location, url));
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method === "POST")) {
      requestInit = { ...requestInit, method: "GET", body: undefined };
    }
  }
}

function providerLoginError(value: unknown): ProviderAuthError | null {
  if (!isRecord(value) || typeof value.error !== "number") {
    return new ProviderAuthError("invalid_response");
  }
  if (value.error === 0) return null;
  if ([48401004, 48401107, 48401128].includes(value.error)) {
    return new ProviderAuthError("invalid_credentials");
  }
  if ([48401108, 48401109, 48401112, 48401005, 48401114, 48401142].includes(value.error)) {
    return new ProviderAuthError("challenge_required");
  }
  if ([48401139, 48401140, 48401141].includes(value.error)) {
    return new ProviderAuthError("rate_limited");
  }
  if (value.error === 10002) return new ProviderAuthError("invalid_input");
  return new ProviderAuthError("invalid_response");
}

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ProviderAuthError("invalid_input");
  }
  return email;
}

function usableDeviceId(value?: string): string {
  if (value === undefined || value === "") return randomBytes(16).toString("hex");
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(value)) throw new ProviderAuthError("invalid_input");
  return value;
}

function requireIdentity(body: unknown, email?: string): void {
  if (!isRecord(body) || body.retcode !== 0 || !isRecord(body.data)) {
    throw new ProviderAuthError("invalid_response");
  }
  const identity = body.data.user_id ?? body.data.id;
  const validStringIdentity = typeof identity === "string" && identity.trim() !== "" && identity.trim() !== "0";
  const validNumericIdentity = typeof identity === "number" && Number.isFinite(identity) && identity > 0;
  if (!validStringIdentity && !validNumericIdentity) {
    throw new ProviderAuthError("invalid_response");
  }
  if (email !== undefined && typeof body.data.email === "string" && normalizedEmail(body.data.email) !== email) {
    throw new ProviderAuthError("invalid_credentials");
  }
}

function toSafeError(error: unknown): ProviderAuthError {
  if (error instanceof ProviderAuthError) return error;
  return new ProviderAuthError("provider_unavailable");
}

function earliestAuthenticationExpiry(cookies: Cookie[]): string | null {
  const expiries = cookies
    .filter((cookie) => cookie.key === "spx_uk" || cookie.key === "fms_user_skey")
    .map((cookie) => cookie.expiryTime())
    .filter((expiry): expiry is number => typeof expiry === "number" && Number.isFinite(expiry) && expiry > Date.now());
  return expiries.length > 0 ? new Date(Math.min(...expiries)).toISOString() : null;
}

export async function loginProvider(
  credentials: ProviderCredentials,
  options: ProviderAuthClientOptions = {},
): Promise<ProviderSession> {
  const deadline = deadlineSignal(options.signal);
  try {
    const email = normalizedEmail(credentials.email);
    if (credentials.password.length === 0) throw new ProviderAuthError("invalid_input");
    const deviceId = usableDeviceId(options.deviceId);
    const fetchImplementation = options.fetch ?? fetch;
    const jar = new CookieJar();
    const csrf = randomBytes(16).toString("hex");
    await jar.setCookie(`csrftoken=${csrf}; Path=/; Secure; SameSite=Lax`, `${ACCOUNTS_ORIGIN}/`);

    const callback = new URL("/auth/callback", LOGISTICS_ORIGIN);
    callback.searchParams.set("refer", `${LOGISTICS_ORIGIN}/#/`);
    const loginPage = new URL("/authenticate/login", ACCOUNTS_ORIGIN);
    for (const [name, value] of Object.entries({
      lang: "th",
      should_hide_back: "true",
      client_id: "15",
      next: callback.href,
    })) loginPage.searchParams.set(name, value);

    const commonHeaders = {
      "user-agent": USER_AGENT,
      "x-app-type": "19",
      "x-csrftoken": csrf,
    };
    const bootstrap = await jarRequest(jar, fetchImplementation, loginPage, {
      method: "GET",
      headers: commonHeaders,
    }, deadline.signal, true);
    if (!bootstrap.response.ok) {
      await discardResponse(bootstrap.response);
      throw statusError(bootstrap.response);
    }
    await boundedText(bootstrap.response);

    const status = await jarRequest(jar, fetchImplementation, `${ACCOUNTS_ORIGIN}/api/v4/account/business/login_status`, {
      method: "POST",
      headers: {
        ...commonHeaders,
        accept: "application/json",
        "content-type": "application/json",
        origin: ACCOUNTS_ORIGIN,
        referer: loginPage.href,
      },
      body: "{}",
    }, deadline.signal);
    if (!status.response.ok) {
      await discardResponse(status.response);
      throw statusError(status.response);
    }
    await boundedText(status.response);

    const hashedPassword = createHash("sha256")
      .update(createHash("md5").update(credentials.password, "utf8").digest("hex"), "utf8")
      .digest("hex");
    const login = await jarRequest(jar, fetchImplementation, `${ACCOUNTS_ORIGIN}/api/v4/account/business/login`, {
      method: "POST",
      headers: {
        ...commonHeaders,
        accept: "application/json",
        "content-type": "application/json",
        origin: ACCOUNTS_ORIGIN,
        referer: loginPage.href,
      },
      body: JSON.stringify({
        email,
        password: hashedPassword,
        captcha_signature: "",
        security_device_fingerprint: "",
      }),
    }, deadline.signal);
    if (!login.response.ok) {
      await discardResponse(login.response);
      throw statusError(login.response);
    }
    const loginBody = await boundedJson(login.response);
    const mappedError = providerLoginError(loginBody);
    if (mappedError) throw mappedError;
    if (!isRecord(loginBody) || !isRecord(loginBody.data) || typeof loginBody.data.nonce !== "string" || loginBody.data.nonce.length === 0) {
      throw new ProviderAuthError("invalid_response");
    }
    const clientCookie = (await jar.getCookies(`${ACCOUNTS_ORIGIN}/`)).find((cookie) => cookie.key === "SPC_CLIENTID");
    if (!clientCookie?.value) throw new ProviderAuthError("invalid_response");

    const ssoUrl = new URL(callback);
    for (const [name, value] of Object.entries({
      code: loginBody.data.nonce,
      spc_clientid: clientCookie.value,
      client_id: "15",
      next: callback.href,
    })) ssoUrl.searchParams.set(name, value);
    const callbackResponse = await jarRequest(jar, fetchImplementation, ssoUrl, {
      method: "GET",
      headers: { ...commonHeaders, referer: `${ACCOUNTS_ORIGIN}/` },
    }, deadline.signal, true);
    if (!callbackResponse.response.ok) {
      await discardResponse(callbackResponse.response);
      throw statusError(callbackResponse.response);
    }
    await boundedText(callbackResponse.response);

    await jar.setCookie(`spx-admin-device-id=${deviceId}; Path=/; Secure`, `${LOGISTICS_ORIGIN}/`);
    await jar.setCookie("spx-admin-lang=th; Path=/; Secure", `${LOGISTICS_ORIGIN}/`);
    const verification = await jarRequest(jar, fetchImplementation, `${LOGISTICS_ORIGIN}${IDENTITY_PATH}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        app: "Agency Portal",
        "device-id": deviceId,
        origin: LOGISTICS_ORIGIN,
        referer: `${LOGISTICS_ORIGIN}/`,
        "user-agent": USER_AGENT,
      },
    }, deadline.signal);
    if (verification.response.status !== 200) {
      await discardResponse(verification.response);
      throw statusError(verification.response);
    }
    requireIdentity(await boundedJson(verification.response), email);

    const logisticsCookies = await jar.getCookies(`${LOGISTICS_ORIGIN}/`);
    const applicableCookies = await jar.getCookies(`${LOGISTICS_ORIGIN}${IDENTITY_PATH}`);
    if (
      !logisticsCookies.some((cookie) => cookie.key === "spx_uk" && cookie.value.trim().length > 0)
      || [...logisticsCookies, ...applicableCookies].some((cookie) =>
        (cookie.key === "spx_uk" && cookie.value.trim().length === 0)
        || (cookie.key === "spx-admin-device-id" && cookie.value !== deviceId))
      || !logisticsCookies.some((cookie) => cookie.key === "spx-admin-device-id" && cookie.value === deviceId)
    ) {
      throw new ProviderAuthError("invalid_response");
    }
    const cookie = await jar.getCookieString(`${LOGISTICS_ORIGIN}/`);
    if (Buffer.byteLength(cookie, "utf8") > MAX_SESSION_COOKIE_BYTES) {
      throw new ProviderAuthError("invalid_response");
    }

    return {
      cookie,
      deviceId,
      expiresAt: earliestAuthenticationExpiry(logisticsCookies),
    };
  } catch (error) {
    throw toSafeError(error);
  } finally {
    deadline.dispose();
  }
}

export async function checkProviderSession(
  session: ProviderSession,
  options: ProviderSessionCheckOptions = {},
): Promise<ProviderSessionCheck> {
  const deadline = deadlineSignal(options.signal);
  try {
    const deviceId = usableDeviceId(session.deviceId);
    if (!session.cookie || Buffer.byteLength(session.cookie, "utf8") > MAX_SESSION_COOKIE_BYTES) {
      return { status: "unavailable", errorCode: "invalid_input", retryAfterMs: null };
    }
    const response = await (options.fetch ?? fetch)(`${LOGISTICS_ORIGIN}${IDENTITY_PATH}`, {
      method: "GET",
      redirect: "manual",
      signal: deadline.signal,
      headers: {
        accept: "application/json",
        app: "Agency Portal",
        cookie: session.cookie,
        "device-id": deviceId,
        origin: LOGISTICS_ORIGIN,
        referer: `${LOGISTICS_ORIGIN}/`,
        "user-agent": USER_AGENT,
      },
    });
    if (response.status === 401) {
      await discardResponse(response);
      return { status: "expired", errorCode: "session_expired" };
    }
    if (response.status === 429) {
      await discardResponse(response);
      return { status: "unavailable", errorCode: "rate_limited", retryAfterMs: parseRetryAfter(response) };
    }
    if (response.status === 403 || response.status >= 500) {
      await discardResponse(response);
      return { status: "unavailable", errorCode: "provider_unavailable", retryAfterMs: parseRetryAfter(response) };
    }
    if (response.status !== 200) {
      await discardResponse(response);
      return { status: "unavailable", errorCode: "invalid_response", retryAfterMs: null };
    }
    const body = await boundedJson(response);
    if (isRecord(body) && body.retcode === 10002) {
      return { status: "unavailable", errorCode: "invalid_input", retryAfterMs: null };
    }
    requireIdentity(body);
    return { status: "valid" };
  } catch (error) {
    const safe = toSafeError(error);
    return {
      status: "unavailable",
      errorCode: safe.code === "session_expired" ? "invalid_response" : safe.code,
      retryAfterMs: safe.retryAfterMs,
    };
  } finally {
    deadline.dispose();
  }
}
