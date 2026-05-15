import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  label: string,
  retries = MAX_RETRIES
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok && attempt < retries && isRetryableStatus(response.status)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        logger.warn(`retryable-response`, { label, url, attempt: attempt + 1, status: response.status, delayMs: Math.round(delay) });
        await sleep(delay);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        logger.warn(`retryable-error`, { label, url, attempt: attempt + 1, delayMs: Math.round(delay), error: lastError.message });
        await sleep(delay);
      }
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

function normalizeApiResponse(value: unknown): ApiResponse | null {
  if (!isRecord(value) || !isRecord(value.data)) {
    return null;
  }

  if (typeof value.retcode !== "number" || typeof value.message !== "string" || !Array.isArray(value.data.list)) {
    return null;
  }

  return {
    retcode: value.retcode,
    message: value.message,
    data: {
      pageno: numberOrDefault(value.data.pageno, env.BIDDING_PAGE_NO),
      count: numberOrDefault(value.data.count, value.data.list.length),
      total: numberOrDefault(value.data.total, value.data.list.length),
      list: value.data.list as ApiResponse["data"]["list"],
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
    cookie: env.COOKIE,
    Referer: env.REFERER,
  };
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
    return {
      pageno: env.BIDDING_PAGE_NO,
      count: env.BIDDING_PAGE_COUNT,
      request_tab_pending_confirmation: env.REQUEST_TAB_PENDING_CONFIRMATION,
      request_ctime_start: env.REQUEST_CTIME_START,
    };
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
    if (firstList.length >= firstPage.data.total) {
      return firstPage;
    }

    const pageSize = Math.max(1, firstPage.data.count || firstList.length || this.body.count);
    const totalPages = Math.ceil(firstPage.data.total / pageSize);
    const pageNumbers: number[] = [];

    for (let pageNo = firstPage.data.pageno + 1; pageNo <= totalPages; pageNo++) {
      pageNumbers.push(pageNo);
    }

    if (pageNumbers.length === 0) {
      return firstPage;
    }

    logger.info("bidding-list-fetching-extra-pages", {
      total: firstPage.data.total,
      firstPageCount: firstList.length,
      extraPages: pageNumbers.length,
    });

    const pageResults = await Promise.all(pageNumbers.map(async (pageNo) => {
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
    }));

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

  async fetchBookingRequestList(bookingId: number): Promise<BookingRequestListResponse | null> {
    const firstPage = await this.fetchBookingRequestListPage(bookingId, 1);
    if (!firstPage) {
      return null;
    }

    const requests = [...firstPage.data.request_list];
    if (requests.length >= firstPage.data.total) {
      return firstPage;
    }

    // Fetch remaining pages in parallel for speed
    const pageSize = Math.max(1, firstPage.data.count || requests.length);
    const totalPages = Math.ceil(firstPage.data.total / pageSize);
    const pageNumbers: number[] = [];
    for (let p = 2; p <= totalPages; p++) pageNumbers.push(p);

    if (pageNumbers.length > 0) {
      const pages = await mapWithConcurrency(
        pageNumbers,
        REQUEST_LIST_PAGE_CONCURRENCY,
        (p) => this.fetchBookingRequestListPage(bookingId, p)
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

  async acceptBookingRequests(bookingId: number, requestIds: number[]): Promise<{ ok: boolean; httpStatus: number; response: AcceptBookingResponse | null; error?: string }> {
    const body: AcceptBookingRequest = {
      booking_id: bookingId,
      accept_all: false,
      request_id_list: requestIds,
    };

    try {
      const response = await fetchWithRetry(this.acceptUrl, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      }, `booking-accept:${bookingId}`, 1);

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
      return { ok: false, httpStatus: 0, response: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchBookingRequestListPage(
    bookingId: number,
    pageNo: number
  ): Promise<BookingRequestListResponse | null> {
    const body: BookingRequestListRequest = {
      request_tab_pending_confirmation: env.REQUEST_TAB_PENDING_CONFIRMATION,
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
