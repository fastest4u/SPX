import type { Dispatcher } from "undici";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { metrics } from "./metrics.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { getSpxDispatcher } from "../utils/http-dispatcher.js";
import type {
  AcceptBookingRequest,
  AcceptBookingResponse,
  ApiResponse,
  BiddingRequest,
  BookingOverviewResponse,
  BookingRequestListRequest,
  BookingRequestListResponse,
  PollingResult,
} from "../models/types.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const REQUEST_LIST_PAGE_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 15_000;
const ACCEPT_TIMEOUT_MS = 10_000;
// Upper bound on how many *extra* list pages we will fan out to fetch. The page
// count is derived from an untrusted `total` field in the API response; a
// malicious or garbage `total` must not be able to trigger unbounded requests.
const MAX_EXTRA_LIST_PAGES = 50;
// Upper bound on a server-supplied Retry-After backoff (ms). Caps how long a
// retryable 429/503 can defer the next attempt regardless of the header value.
const MAX_RETRY_AFTER_MS = 30_000;

interface BookingRequestListOptions {
  tabPendingConfirmation?: boolean;
  onPage?: (page: BookingRequestListResponse) => void;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Coerce an untrusted `total` field into a finite, non-negative integer. NaN,
 * negative, Infinity, and non-numeric values collapse to 0 so they cannot drive
 * page fan-out.
 */
function safeTotal(total: unknown): number {
  return typeof total === "number" && Number.isFinite(total) && total > 0
    ? Math.floor(total)
    : 0;
}

/**
 * Parse a Retry-After header (RFC 7231: either delta-seconds or an HTTP-date)
 * into a bounded backoff in milliseconds. Returns null when the header is
 * absent or unparseable so the caller falls back to its computed backoff.
 */
function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  const trimmed = header.trim();
  let ms: number;

  if (/^\d+$/.test(trimmed)) {
    // delta-seconds
    ms = Number(trimmed) * 1000;
  } else {
    const dateMs = Date.parse(trimmed);
    if (Number.isNaN(dateMs)) return null;
    ms = dateMs - Date.now();
  }

  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  label: string,
  retries = MAX_RETRIES,
  timeoutMs = FETCH_TIMEOUT_MS,
  idempotent = true,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Route through the shared keep-alive pool so the list/request-list/accept
      // hops reuse warm connections (DOM's RequestInit type omits `dispatcher`,
      // which undici reads at runtime — hence the typed extension).
      // Count every request sent so the connection-reuse ratio (vs new sockets) is measurable.
      metrics.recordUpstreamRequest();
      const init: RequestInit & { dispatcher?: Dispatcher } = {
        ...options,
        signal: controller.signal,
        dispatcher: getSpxDispatcher(),
      };
      const response = await fetch(url, init);
      // Never retry a non-idempotent request (e.g. POST accept) on a response
      // error: the server may already have committed the side effect, so a retry
      // risks a duplicate. Return the response and let the caller reconcile.
      if (!response.ok && idempotent && attempt < retries && isRetryableStatus(response.status)) {
        // Prefer a server-supplied Retry-After (429/503) when present, bounded
        // to MAX_RETRY_AFTER_MS; otherwise fall back to exponential backoff.
        const computedDelay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        const retryAfterMs = parseRetryAfterMs(response);
        const delay = retryAfterMs ?? computedDelay;
        logger.warn(`retryable-response`, {
          label,
          url,
          attempt: attempt + 1,
          status: response.status,
          delayMs: Math.round(delay),
          retryAfter: retryAfterMs !== null,
        });
        await sleep(delay);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isAbort = lastError.name === "AbortError";
      // A thrown error (timeout/network) on a non-idempotent request is ambiguous
      // — the request may have been delivered and processed server-side. Surface
      // it instead of retrying so we cannot double-submit.
      if (!idempotent) {
        throw lastError;
      }
      if (attempt < retries) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        logger.warn(`retryable-error`, {
          label,
          url,
          attempt: attempt + 1,
          delayMs: Math.round(delay),
          error: isAbort ? `timeout after ${timeoutMs}ms` : lastError.message,
        });
        await sleep(delay);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${label}`);
}

/** Retcodes that indicate session/auth expiry */
const SESSION_EXPIRED_CODES = new Set([401, 403, -1, 10001, 10002]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

export function normalizeApiResponse(value: unknown): ApiResponse | null {
  if (!isRecord(value) || !isRecord(value.data)) {
    return null;
  }

  const rawList = value.data.list;
  if (
    typeof value.retcode !== "number" ||
    typeof value.message !== "string" ||
    (rawList !== null && !Array.isArray(rawList))
  ) {
    return null;
  }

  const list = (rawList ?? []) as ApiResponse["data"]["list"];
  const total = numberOrDefault(value.data.total, list.length);

  return {
    retcode: value.retcode,
    message: value.message,
    data: {
      pageno: numberOrDefault(value.data.pageno, env.BIDDING_PAGE_NO),
      count: numberOrDefault(value.data.count, list.length),
      total: Math.max(total, list.length),
      list,
    },
  };
}

function isBookingOverviewResponse(value: unknown): value is BookingOverviewResponse {
  if (!isRecord(value) || !isRecord(value.data)) {
    return false;
  }

  return (
    typeof value.retcode === "number" &&
    typeof value.message === "string" &&
    typeof value.data.id === "number" &&
    Array.isArray(value.data.vehicle_driver_info)
  );
}

function normalizeBookingRequestListResponse(value: unknown): BookingRequestListResponse | null {
  if (!isRecord(value) || !isRecord(value.data)) {
    return null;
  }

  if (typeof value.retcode !== "number" || typeof value.message !== "string" || !Array.isArray(value.data.request_list)) {
    return null;
  }

  return {
    retcode: value.retcode,
    message: value.message,
    data: {
      pageno: numberOrDefault(value.data.pageno, 1),
      count: numberOrDefault(value.data.count, value.data.request_list.length),
      total: numberOrDefault(value.data.total, value.data.request_list.length),
      request_list: value.data.request_list as BookingRequestListResponse["data"]["request_list"],
    },
  };
}

function getRetcode(value: unknown): number | null {
  return isRecord(value) && typeof value.retcode === "number" ? value.retcode : null;
}

function getMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === "string" ? value.message : "";
}

function buildHeaders(): Record<string, string> {
  const origin = (() => {
    try {
      return new URL(env.REFERER).origin;
    } catch {
      return "https://logistics.myagencyservice.in.th";
    }
  })();

  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "th,en;q=0.9",
    app: env.APP_NAME,
    "content-type": "application/json;charset=UTF-8",
    "device-id": env.DEVICE_ID,
    priority: "u=1, i",
    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    origin,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    cookie: env.COOKIE,
    Referer: env.REFERER,
  };
}

export function buildBiddingListBody(pageNo: number): BiddingRequest {
  const body: BiddingRequest = {
    pageno: pageNo,
    count: env.BIDDING_PAGE_COUNT,
    request_tab_pending_confirmation: env.REQUEST_TAB_PENDING_CONFIRMATION,
    request_ctime_start: env.REQUEST_CTIME_START,
  };

  if (env.BIDDING_VEHICLE_TYPE !== undefined) {
    body.vehicle_type = env.BIDDING_VEHICLE_TYPE;
  }

  return body;
}

export class ApiClient {
  private cookieOverride: string | null = null;

  constructor() {
    // No caching — all env reads happen per-fetch via getters below
  }

  private get headers(): Record<string, string> {
    const h = buildHeaders();
    if (this.cookieOverride) {
      h.cookie = this.cookieOverride;
    }
    return h;
  }

  private get body(): BiddingRequest {
    return buildBiddingListBody(env.BIDDING_PAGE_NO);
  }

  private get overviewBaseUrl(): string {
    return env.API_URL.replace("/booking/bidding/list", "/booking/bidding/booking_overview");
  }

  private get requestListUrl(): string {
    return env.API_URL.replace("/booking/bidding/list", "/booking/bidding/request/list");
  }

  private get acceptUrl(): string {
    return env.API_URL.replace("/booking/bidding/list", "/booking/bidding/accept");
  }

  async fetch(requestNumber: number): Promise<PollingResult> {
    const startTime = Date.now();
    try {
      const response = await this.fetchBiddingListPage(this.body.pageno);

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          latencyMs,
          httpStatus: response.status,
          error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
          timestamp: new Date(),
          requestNumber,
        };
      }

      const data: unknown = await response.json();
      const apiResponse = normalizeApiResponse(data);
      const retcode = getRetcode(data);

      if (retcode !== null && SESSION_EXPIRED_CODES.has(retcode)) {
        return {
          success: false,
          latencyMs,
          httpStatus: response.status,
          error: `Session expired (retcode=${retcode}): ${getMessage(data)}`,
          timestamp: new Date(),
          requestNumber,
        };
      }

      if (!apiResponse) {
        return {
          success: false,
          latencyMs,
          httpStatus: response.status,
          error: "Unexpected bidding list response shape",
          timestamp: new Date(),
          requestNumber,
        };
      }

      if (SESSION_EXPIRED_CODES.has(apiResponse.retcode)) {
        return {
          success: false,
          latencyMs,
          httpStatus: response.status,
          error: `Session expired (retcode=${apiResponse.retcode}): ${apiResponse.message}`,
          timestamp: new Date(),
          requestNumber,
        };
      }

      const allPagesResponse = await this.fetchRemainingBiddingListPages(apiResponse);

      return {
        success: true,
        data: allPagesResponse,
        latencyMs: Date.now() - startTime,
        httpStatus: response.status,
        timestamp: new Date(),
        requestNumber,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      return {
        success: false,
        latencyMs,
        httpStatus: 0,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date(),
        requestNumber,
      };
    }
  }

  private async fetchBiddingListPage(pageNo: number): Promise<Response> {
    return fetchWithRetry(env.API_URL, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ ...this.body, pageno: pageNo }),
    }, `bidding-list:${pageNo}`);
  }

  private async fetchRemainingBiddingListPages(firstPage: ApiResponse): Promise<ApiResponse> {
    const firstList = firstPage.data.list;
    const total = safeTotal(firstPage.data.total);
    if (firstList.length >= total) {
      return firstPage;
    }

    const pageSize = Math.max(1, firstPage.data.count || firstList.length || this.body.count);
    const requestedPages = Math.ceil(total / pageSize);
    const totalPages = Math.min(requestedPages, firstPage.data.pageno + MAX_EXTRA_LIST_PAGES);
    if (requestedPages > totalPages) {
      logger.warn("bidding-list-page-cap-applied", {
        total,
        pageSize,
        requestedPages,
        cappedPages: totalPages,
        maxExtraPages: MAX_EXTRA_LIST_PAGES,
      });
    }
    const pageNumbers: number[] = [];

    for (let pageNo = firstPage.data.pageno + 1; pageNo <= totalPages; pageNo++) {
      pageNumbers.push(pageNo);
    }

    if (pageNumbers.length === 0) {
      return firstPage;
    }

    logger.info("bidding-list-fetching-extra-pages", {
      total,
      firstPageCount: firstList.length,
      extraPages: pageNumbers.length,
    });

    const pageResults = await mapWithConcurrency(
      pageNumbers,
      REQUEST_LIST_PAGE_CONCURRENCY,
      async (pageNo) => {
        try {
          const response = await this.fetchBiddingListPage(pageNo);
          if (!response.ok) {
            logger.warn("bidding-list-page-failed", { pageNo, status: response.status });
            return null;
          }

          const data: unknown = await response.json();
          const page = normalizeApiResponse(data);
          if (!page) {
            logger.warn("bidding-list-page-unexpected-shape", { pageNo });
            return null;
          }

          return page;
        } catch (err) {
          logger.warn("bidding-list-page-error", { pageNo, error: err instanceof Error ? err.message : String(err) });
          return null;
        }
      }
    );

    const allList = [...firstList];
    for (const page of pageResults) {
      if (!page) continue;
      allList.push(...page.data.list);
    }

    return {
      ...firstPage,
      data: {
        ...firstPage.data,
        count: allList.length,
        list: allList,
      },
    };
  }

  async fetchBookingOverview(bookingId: number): Promise<BookingOverviewResponse | null> {
    const url = `${this.overviewBaseUrl}?id=${bookingId}`;
    try {
      const response = await fetchWithRetry(url, { method: "GET", headers: this.headers }, "booking-overview");
      if (!response.ok) return null;
      const data: unknown = await response.json();
      return isBookingOverviewResponse(data) ? data : null;
    } catch (err) {
      logger.warn("booking-overview-failed", { bookingId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async fetchBookingRequestList(
    bookingId: number,
    options: BookingRequestListOptions = {}
  ): Promise<BookingRequestListResponse | null> {
    const tabPendingConfirmation = options.tabPendingConfirmation ?? env.REQUEST_TAB_PENDING_CONFIRMATION;
    const firstPage = await this.fetchBookingRequestListPage(bookingId, 1, tabPendingConfirmation);
    if (!firstPage) {
      return null;
    }
    this.notifyBookingRequestListPage(bookingId, firstPage, options.onPage);

    const requests = [...firstPage.data.request_list];
    const total = safeTotal(firstPage.data.total);
    if (requests.length >= total) {
      return firstPage;
    }

    // Fetch remaining pages in parallel for speed
    const pageSize = Math.max(1, firstPage.data.count || requests.length);
    const requestedPages = Math.ceil(total / pageSize);
    // Page count is derived from an untrusted `total`; cap fan-out (pages start
    // at 1 here, so 1 + MAX_EXTRA_LIST_PAGES bounds the extra pages).
    const totalPages = Math.min(requestedPages, 1 + MAX_EXTRA_LIST_PAGES);
    if (requestedPages > totalPages) {
      logger.warn("booking-request-list-page-cap-applied", {
        bookingId,
        total,
        pageSize,
        requestedPages,
        cappedPages: totalPages,
        maxExtraPages: MAX_EXTRA_LIST_PAGES,
      });
    }
    const pageNumbers: number[] = [];
    for (let p = 2; p <= totalPages; p++) pageNumbers.push(p);

    if (pageNumbers.length > 0) {
      const pages = await mapWithConcurrency(
        pageNumbers,
        REQUEST_LIST_PAGE_CONCURRENCY,
        async (p) => {
          const page = await this.fetchBookingRequestListPage(bookingId, p, tabPendingConfirmation);
          if (page) this.notifyBookingRequestListPage(bookingId, page, options.onPage);
          return page;
        }
      );
      for (const page of pages) {
        if (page && page.data.request_list.length > 0) {
          requests.push(...page.data.request_list);
        }
      }
    }

    return {
      ...firstPage,
      data: {
        ...firstPage.data,
        request_list: requests,
      },
    };
  }

  private notifyBookingRequestListPage(
    bookingId: number,
    page: BookingRequestListResponse,
    onPage: BookingRequestListOptions["onPage"]
  ): void {
    if (!onPage) return;
    try {
      onPage(page);
    } catch (err) {
      logger.warn("booking-request-list-page-callback-failed", {
        bookingId,
        pageNo: page.data.pageno,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async acceptBookingRequests(bookingId: number, requestIds: number[]): Promise<{ ok: boolean; httpStatus: number; response: AcceptBookingResponse | null; error?: string }> {
    const body: AcceptBookingRequest = {
      booking_id: bookingId,
      accept_all: false,
      request_id_list: requestIds,
    };

    // Bracket only the upstream POST so we measure the decisive accept round-trip
    // in isolation (the rest — parsing/normalization — is local CPU). This is the
    // competitive number that was previously never timed on its own.
    const acceptStart = Date.now();
    let acceptRttRecorded = false;
    try {
      // Accept is a non-idempotent POST with real operational/financial impact.
      // Do not retry it: `idempotent=false` makes both response-error and
      // thrown-error retries no-ops, and the notifier reconciles the true state
      // against the pending + confirmed tabs afterwards.
      const response = await fetchWithRetry(this.acceptUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      }, `booking-accept:${bookingId}`, 0, ACCEPT_TIMEOUT_MS, false);
      metrics.recordOperation("acceptRtt", Date.now() - acceptStart);
      acceptRttRecorded = true;

      const rawText = await response.text();
      let parsed: unknown = null;
      if (rawText.trim()) {
        try {
          parsed = JSON.parse(rawText) as unknown;
        } catch {
          return { ok: false, httpStatus: response.status, response: null, error: `Unexpected accept response: ${rawText.slice(0, 200)}` };
        }
      }

      const retcode = getRetcode(parsed);
      const message = getMessage(parsed);
      const normalized: AcceptBookingResponse | null = retcode === null
        ? null
        : { retcode, message, data: isRecord(parsed) ? parsed.data : undefined };

      if (!response.ok) {
        return { ok: false, httpStatus: response.status, response: normalized, error: `HTTP ${response.status}: ${rawText.slice(0, 200)}` };
      }

      if (retcode !== null && SESSION_EXPIRED_CODES.has(retcode)) {
        return { ok: false, httpStatus: response.status, response: normalized, error: `Session expired (retcode=${retcode}): ${message}` };
      }

      if (retcode !== null && retcode !== 0) {
        return { ok: false, httpStatus: response.status, response: normalized, error: message || `Accept failed with retcode ${retcode}` };
      }

      return { ok: true, httpStatus: response.status, response: normalized };
    } catch (err) {
      // Record the time-to-failure too (timeout/network) so the accept latency
      // bucket reflects failed attempts — but only if the upstream POST itself
      // failed. A post-response parse error has already recorded the real RTT,
      // so guard against double-counting (which would also inflate the value).
      if (!acceptRttRecorded) metrics.recordOperation("acceptRtt", Date.now() - acceptStart);
      return { ok: false, httpStatus: 0, response: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchBookingRequestListPage(
    bookingId: number,
    pageNo: number,
    tabPendingConfirmation: boolean = env.REQUEST_TAB_PENDING_CONFIRMATION
  ): Promise<BookingRequestListResponse | null> {
    const body: BookingRequestListRequest = {
      request_tab_pending_confirmation: tabPendingConfirmation,
      booking_id: bookingId,
      pageno: pageNo,
      count: env.BIDDING_PAGE_COUNT,
    };

    try {
      const response = await fetchWithRetry(this.requestListUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      }, `booking-request-list:${bookingId}:${pageNo}`);

      if (!response.ok) return null;
      const data: unknown = await response.json();
      return normalizeBookingRequestListResponse(data);
    } catch (err) {
      logger.warn("booking-request-list-failed", { bookingId, pageNo, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  setCookie(cookie: string): void {
    this.cookieOverride = cookie;
  }
}
