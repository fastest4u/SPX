import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type {
  ApiResponse,
  BiddingRequest,
  BookingOverviewResponse,
  BookingRequestListRequest,
  BookingRequestListResponse,
  PollingResult,
} from "../models/types.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  private headers: Record<string, string>;
  private body: BiddingRequest;
  private readonly overviewBaseUrl: string;
  private readonly requestListUrl: string;

  constructor() {
    this.headers = buildHeaders();
    this.body = {
      pageno: env.BIDDING_PAGE_NO,
      count: env.BIDDING_PAGE_COUNT,
      request_tab_pending_confirmation: env.REQUEST_TAB_PENDING_CONFIRMATION,
      request_ctime_start: env.REQUEST_CTIME_START,
    };
    this.overviewBaseUrl = env.API_URL.replace("/booking/bidding/list", "/booking/bidding/booking_overview");
    this.requestListUrl = env.API_URL.replace("/booking/bidding/list", "/booking/bidding/request/list");
  }

  async fetch(requestNumber: number): Promise<PollingResult> {
    const startTime = Date.now();
    try {
      const response = await fetchWithRetry(env.API_URL, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(this.body),
      }, "bidding-list");

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

      return {
        success: true,
        data: apiResponse,
        latencyMs,
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
    let pageNo = 2;

    while (requests.length < firstPage.data.total) {
      const page = await this.fetchBookingRequestListPage(bookingId, pageNo);
      if (!page || page.data.request_list.length === 0) {
        break;
      }

      requests.push(...page.data.request_list);
      pageNo++;
    }

    return {
      ...firstPage,
      data: {
        ...firstPage.data,
        request_list: requests,
      },
    };
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
    this.headers.cookie = cookie;
  }
}
