import type {
  AcceptBookingInput,
  AcceptAllBookingInput,
  AcceptAllBookingResponse,
  AcceptBookingResponse,
  ApiErrorResponse,
  ApiPaginatedResponse,
  ApiSuccessResponse,
  AuditLog,
  AuditQuery,
  AuthUser,
  AutoAcceptHistoryItem,
  AutoAcceptHistoryQuery,
  BookingHistory,
  CodexDeviceAuthComplete,
  CodexDeviceAuthStart,
  CodexDeviceAuthStatus,
  CreateUserInput,
  HealthResponse,
  HistoryFilterQuery,
  HistoryFilterOptions,
  LineBotGroupList,
  LineBotSendInput,
  LineBotSendResult,
  LineBotStatus,
  LoginResponse,
  MetricsHistoryRow,
  LineImageExtraction,
  LineImageExtractionQuery,
  LineQuota,
  MetricsSnapshot,
  NotifyRule,
  NotificationPreview,
  NotificationTestResult,
  PasswordInput,
  ReadyResponse,
  RoleInput,
  RuleInput,
  RulePatch,
  RulePreviewResult,
  SettingsResponse,
  Team,
  TeamInput,
  User,
} from '../types'

const API_BASE = '/api'

/** Flag to prevent multiple simultaneous 401 redirects */
let isRedirectingToLogin = false

/**
 * Endpoints that must NOT trigger the silent-refresh-then-redirect flow on 401.
 * A 401 from these is terminal: refreshing would either be pointless (`/me`,
 * `/login`) or recurse (`/refresh`). Matched against the parsed pathname so
 * query strings and host differences cannot fool the check.
 */
const AUTH_EXEMPT_PATHS = ['/api/login', '/api/me', '/api/refresh']

/** Parse the pathname from a same-origin or absolute URL, tolerating relatives. */
function pathnameOf(url: string): string {
  try {
    return new URL(url, window.location.origin).pathname
  } catch {
    // Fall back to stripping any query/hash from a raw string.
    return url.split('?')[0].split('#')[0]
  }
}

/** True when the URL targets one of the auth-exempt endpoints. */
function isAuthExempt(url: string): boolean {
  const pathname = pathnameOf(url)
  return AUTH_EXEMPT_PATHS.some(
    exempt => pathname === exempt || pathname.endsWith(exempt),
  )
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { status?: unknown }).status === 'error' &&
    typeof (value as { error_code?: unknown }).error_code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string',
  )
}

function buildAuthError(data: unknown): AuthError {
  if (isApiErrorResponse(data)) {
    return new AuthError(`${data.error_code}: ${data.message}`)
  }
  return new AuthError('UNAUTHORIZED: Authentication required')
}

async function handleUnauthorized<T>(
  url: string,
  alreadyRetried: boolean,
  data: unknown,
  retryOriginal: () => Promise<T>,
): Promise<T> {
  const exempt = isAuthExempt(url)

  if (!exempt && !alreadyRetried) {
    const refreshed = await attemptSilentRefresh()
    if (refreshed) {
      return retryOriginal()
    }
  }

  if (!exempt && !isRedirectingToLogin) {
    isRedirectingToLogin = true
    window.location.replace('/login')
    setTimeout(() => { isRedirectingToLogin = false }, 1000)
  }

  throw buildAuthError(data)
}

/**
 * Builds a `URLSearchParams` query string from a flat params object, skipping
 * `undefined` and empty-string values. Returns the bare query (no leading `?`).
 */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const queryParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    queryParams.set(key, String(value))
  }
  return queryParams.toString()
}

/** Attempt a single silent token refresh. Resolves true on success. */
async function attemptSilentRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    return response.ok
  } catch {
    return false
  }
}

async function fetchRaw<T>(
  url: string,
  options?: RequestInit,
  alreadyRetried = false,
): Promise<ApiSuccessResponse<T>> {
  const headers = new Headers(options?.headers)
  if (options?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers,
  })

  const data = await response.json().catch(() => ({ status: 'error', error_code: 'PARSE_ERROR', message: 'Failed to parse response' })) as ApiSuccessResponse<T> | ApiErrorResponse

  // Global 401 handler — try one silent refresh + retry before redirecting.
  if (response.status === 401) {
    return handleUnauthorized<ApiSuccessResponse<T>>(
      url,
      alreadyRetried,
      data,
      () => fetchRaw<T>(url, options, true),
    )
  }

  if (!response.ok || data.status === 'error') {
    const errorData = data as ApiErrorResponse
    throw new Error(`${errorData.error_code}: ${errorData.message}`)
  }

  return data as ApiSuccessResponse<T>
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetchRaw<T>(url, options)
  return response.data
}

async function fetchPaginated<T>(url: string, options?: RequestInit): Promise<ApiPaginatedResponse<T>> {
  const response = await fetchRaw<T[]>(url, options)
  if (!('meta' in response)) {
    throw new Error('Expected paginated response but got regular success response')
  }
  return response as unknown as ApiPaginatedResponse<T>
}

async function fetchPlain<T>(
  url: string,
  options?: RequestInit,
  retries = 3,
  alreadyRetriedAuth = false,
): Promise<T> {
  let lastError: unknown
  // Only retry idempotent methods. POST/PUT/DELETE could double-execute side
  // effects (e.g. /system/pause flip-flopping) so we run them once.
  const method = (options?.method ?? 'GET').toUpperCase()
  const isIdempotent = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  const effectiveRetries = isIdempotent ? retries : 1

  for (let attempt = 0; attempt < effectiveRetries; attempt += 1) {
    try {
      const headers = new Headers(options?.headers)
      if (options?.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
      }

      const response = await fetch(url, {
        ...options,
        credentials: 'include',
        headers,
      })
      const data = await response.json().catch(() => null) as T | ApiErrorResponse | null
      if (response.status === 401) {
        return handleUnauthorized<T>(
          url,
          alreadyRetriedAuth,
          data,
          () => fetchPlain<T>(url, options, retries, true),
        )
      }
      if (!response.ok) {
        if (isIdempotent && response.status >= 500 && attempt < effectiveRetries - 1) {
          const delayMs = 250 * 2 ** attempt
          await new Promise(resolve => setTimeout(resolve, delayMs))
          continue
        }
        if (data && typeof data === 'object' && 'status' in data && data.status === 'error') {
          throw new Error(`${data.error_code}: ${data.message}`)
        }
        throw new Error(`REQUEST_ERROR: ${response.statusText || 'Request failed'}`)
      }
      // The auth/dashboard controllers wrap responses in a `{status, message, data}`
      // envelope (see `sendSuccess` in `src/utils/response.ts`). Unwrap automatically
      // so callers can declare the inner payload as their `T` and access fields
      // directly. Fall back to the raw body for legacy endpoints that return JSON
      // without the envelope.
      if (
        data &&
        typeof data === 'object' &&
        'status' in data &&
        (data as { status?: unknown }).status === 'success' &&
        'data' in data
      ) {
        return (data as { data: T }).data
      }
      return data as T
    } catch (error) {
      lastError = error
      if (error instanceof AuthError) throw error
      if (isIdempotent && attempt < effectiveRetries - 1) {
        const delayMs = 250 * 2 ** attempt
        await new Promise(resolve => setTimeout(resolve, delayMs))
        continue
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('REQUEST_ERROR: Request failed')
}

/** Custom error class for auth failures — TanStack Query should NOT retry these */
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

// Auth API
export const authApi = {
  login: (username: string, password: string): Promise<LoginResponse> =>
    fetchJson<LoginResponse>(`${API_BASE}/login`, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: (): Promise<null> =>
    fetchJson<null>(`${API_BASE}/logout`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  refresh: (): Promise<null> =>
    fetchJson<null>(`${API_BASE}/refresh`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  me: (): Promise<AuthUser> =>
    fetchJson<AuthUser>(`${API_BASE}/me`),
}

// Rules API
export const rulesApi = {
  list: (): Promise<NotifyRule[]> =>
    fetchJson<NotifyRule[]>(`${API_BASE}/rules`),

  get: (id: string): Promise<NotifyRule> =>
    fetchJson<NotifyRule>(`${API_BASE}/rules/${id}`),

  create: (rule: RuleInput): Promise<NotifyRule> =>
    fetchJson<NotifyRule>(`${API_BASE}/rules`, {
      method: 'POST',
      body: JSON.stringify(rule),
    }),

  preview: (rule: RuleInput | NotifyRule, options?: { limit?: number; sampleLimit?: number }): Promise<RulePreviewResult> =>
    fetchJson<RulePreviewResult>(`${API_BASE}/rules/preview`, {
      method: 'POST',
      body: JSON.stringify({
        rule: {
          teamId: rule.teamId,
          name: rule.name,
          origins: rule.origins,
          destinations: rule.destinations,
          vehicle_types: rule.vehicle_types,
          need: rule.need,
          enabled: rule.enabled,
        },
        limit: options?.limit ?? 200,
        sampleLimit: options?.sampleLimit ?? 8,
      }),
    }),

  update: (id: string, patch: RulePatch): Promise<NotifyRule> =>
    fetchJson<NotifyRule>(`${API_BASE}/rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  delete: (id: string): Promise<null> =>
    fetchJson<null>(`${API_BASE}/rules/${id}`, {
      method: 'DELETE',
    }),
}

// History API
export const historyApi = {
  list: (params?: HistoryFilterQuery): Promise<BookingHistory[]> => {
    const query = buildQuery({
      limit: params?.limit,
      search: params?.search,
      requestId: params?.requestId,
      bookingId: params?.bookingId,
      origin: params?.origin,
      destination: params?.destination,
      vehicleType: params?.vehicleType,
      teamId: params?.teamId,
      sortBy: params?.sortBy,
      sortDir: params?.sortDir,
    })
    return fetchJson<BookingHistory[]>(`${API_BASE}/history${query ? `?${query}` : ''}`)
  },

  paginated: (params?: HistoryFilterQuery): Promise<ApiPaginatedResponse<BookingHistory>> => {
    const query = buildQuery({
      page: params?.page,
      pageSize: params?.pageSize,
      search: params?.search,
      requestId: params?.requestId,
      bookingId: params?.bookingId,
      origin: params?.origin,
      destination: params?.destination,
      vehicleType: params?.vehicleType,
      teamId: params?.teamId,
      sortBy: params?.sortBy,
      sortDir: params?.sortDir,
    })
    return fetchPaginated<BookingHistory>(`${API_BASE}/history/paginated${query ? `?${query}` : ''}`)
  },

  filterOptions: (params?: Pick<HistoryFilterQuery, 'teamId'>): Promise<HistoryFilterOptions> => {
    const query = buildQuery({
      teamId: params?.teamId,
    })
    return fetchJson<HistoryFilterOptions>(`${API_BASE}/history/filter-options${query ? `?${query}` : ''}`)
  },
}

// Audit API
export const auditApi = {
  list: (params?: AuditQuery): Promise<AuditLog[]> => {
    const query = buildQuery({
      limit: params?.limit,
      search: params?.search,
      username: params?.username,
      action: params?.action,
      sortBy: params?.sortBy,
      sortDir: params?.sortDir,
    })
    return fetchJson<AuditLog[]>(`${API_BASE}/audit-logs${query ? `?${query}` : ''}`)
  },

  paginated: (params?: AuditQuery): Promise<ApiPaginatedResponse<AuditLog>> => {
    const query = buildQuery({
      page: params?.page,
      pageSize: params?.pageSize,
      search: params?.search,
      username: params?.username,
      action: params?.action,
      sortBy: params?.sortBy,
      sortDir: params?.sortDir,
    })
    return fetchPaginated<AuditLog>(`${API_BASE}/audit-logs/paginated${query ? `?${query}` : ''}`)
  },
}

// Auto-Accept History API
export const autoAcceptHistoryApi = {
  list: (params?: AutoAcceptHistoryQuery): Promise<AutoAcceptHistoryItem[]> => {
    const query = buildQuery({
      limit: params?.limit,
      search: params?.search,
      ruleName: params?.ruleName,
      status: params?.status,
      sortBy: params?.sortBy,
      sortDir: params?.sortDir,
    })
    return fetchJson<AutoAcceptHistoryItem[]>(`${API_BASE}/auto-accept-history${query ? `?${query}` : ''}`)
  },

  paginated: (params?: AutoAcceptHistoryQuery): Promise<ApiPaginatedResponse<AutoAcceptHistoryItem>> => {
    const query = buildQuery({
      page: params?.page,
      pageSize: params?.pageSize,
      search: params?.search,
      ruleName: params?.ruleName,
      status: params?.status,
      sortBy: params?.sortBy,
      sortDir: params?.sortDir,
    })
    return fetchPaginated<AutoAcceptHistoryItem>(`${API_BASE}/auto-accept-history/paginated${query ? `?${query}` : ''}`)
  },
}

// Users API
export const usersApi = {
  list: (): Promise<User[]> =>
    fetchJson<User[]>(`${API_BASE}/users`),

  create: (user: CreateUserInput): Promise<null> =>
    fetchJson<null>(`${API_BASE}/users`, {
      method: 'POST',
      body: JSON.stringify(user),
    }),

  updatePassword: (id: number, password: string): Promise<null> =>
    fetchJson<null>(`${API_BASE}/users/${id}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password } as PasswordInput),
    }),

  updateRole: (id: number, role: 'user' | 'admin', teamId?: number | null): Promise<null> =>
    fetchJson<null>(`${API_BASE}/users/${id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role, teamId } as RoleInput),
    }),

  updateTeam: (id: number, teamId: number | null): Promise<null> =>
    fetchJson<null>(`${API_BASE}/users/${id}/team`, {
      method: 'PUT',
      body: JSON.stringify({ teamId }),
    }),

  delete: (id: number): Promise<null> =>
    fetchJson<null>(`${API_BASE}/users/${id}`, {
      method: 'DELETE',
    }),
}

// Teams API
export const teamsApi = {
  list: (): Promise<Team[]> =>
    fetchJson<Team[]>(`${API_BASE}/teams`),

  get: (id: number): Promise<Team> =>
    fetchJson<Team>(`${API_BASE}/teams/${id}`),

  create: (team: TeamInput): Promise<Team> =>
    fetchJson<Team>(`${API_BASE}/teams`, {
      method: 'POST',
      body: JSON.stringify(team),
    }),

  update: (id: number, team: Partial<TeamInput>): Promise<Team> =>
    fetchJson<Team>(`${API_BASE}/teams/${id}`, {
      method: 'PUT',
      body: JSON.stringify(team),
    }),

  disable: (id: number): Promise<null> =>
    fetchJson<null>(`${API_BASE}/teams/${id}/disable`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  restart: (id: number): Promise<Team> =>
    fetchJson<Team>(`${API_BASE}/teams/${id}/restart-poller`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  pause: (id: number): Promise<Team> =>
    fetchJson<Team>(`${API_BASE}/teams/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  resume: (id: number): Promise<Team> =>
    fetchJson<Team>(`${API_BASE}/teams/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  restartAll: (): Promise<Team[]> =>
    fetchJson<Team[]>(`${API_BASE}/teams/restart-all`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
}

// Settings API
function isSettingsResponse(
  response: Record<string, string> | SettingsResponse,
): response is SettingsResponse {
  return Boolean(
    response &&
    typeof response === 'object' &&
    'values' in response &&
    typeof (response as SettingsResponse).values === 'object' &&
    (response as SettingsResponse).values !== null,
  )
}

function normalizeSettingsResponse(
  response: Record<string, string> | SettingsResponse,
): SettingsResponse {
  if (isSettingsResponse(response)) {
    return {
      values: response.values,
      reloadBehavior: response.reloadBehavior ?? {},
    }
  }
  return {
    values: response,
    reloadBehavior: {},
  }
}

export const settingsApi = {
  getDetailed: async (): Promise<SettingsResponse> => {
    const response = await fetchJson<Record<string, string> | SettingsResponse>(`${API_BASE}/settings`)
    return normalizeSettingsResponse(response)
  },

  get: async (): Promise<Record<string, string>> => {
    const response = await settingsApi.getDetailed()
    return response.values
  },

  update: (settings: Record<string, string>): Promise<null> =>
    fetchJson<null>(`${API_BASE}/settings`, {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
}

// Metrics API
export const metricsApi = {
  snapshot: (): Promise<MetricsSnapshot> =>
    fetchPlain<MetricsSnapshot>('/metrics'),

  history: (limit?: number): Promise<MetricsHistoryRow[]> =>
    fetchPlain<MetricsHistoryRow[]>(`/metrics/history${limit ? `?limit=${limit}` : ''}`),

  pause: (): Promise<{ paused: boolean }> =>
    fetchPlain<{ paused: boolean }>('/system/pause', { method: 'POST' }),

  resume: (): Promise<{ paused: boolean }> =>
    fetchPlain<{ paused: boolean }>('/system/resume', { method: 'POST' }),
}

export const lineApi = {
  quota: (): Promise<LineQuota | null> =>
    fetchPlain<LineQuota | null>('/line-quota'),
}

// Health/Ready API
export const healthApi = {
  health: (): Promise<HealthResponse> =>
    fetchPlain<HealthResponse>('/health'),

  ready: (): Promise<ReadyResponse> =>
    fetchPlain<ReadyResponse>('/ready'),
}

// Bidding API
export const biddingApi = {
  accept: (input: AcceptBookingInput): Promise<AcceptBookingResponse> =>
    fetchJson<AcceptBookingResponse>(`${API_BASE}/bidding/accept`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  acceptAll: (input: AcceptAllBookingInput): Promise<AcceptAllBookingResponse> =>
    fetchJson<AcceptAllBookingResponse>(`${API_BASE}/bidding/accept-all`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
}

// Notifications API
export const notificationsApi = {
  preview: (): Promise<NotificationPreview> =>
    fetchJson<NotificationPreview>(`${API_BASE}/notifications/preview`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  test: (): Promise<NotificationTestResult> =>
    fetchJson<NotificationTestResult>(`${API_BASE}/notifications/test`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
}

// Reports API
export const reportsApi = {
  downloadMetrics: (): void => {
    window.open(`${API_BASE}/reports/metrics.csv`, '_blank')
  },

  downloadHistory: (): void => {
    window.open(`${API_BASE}/reports/history.csv`, '_blank')
  },

  downloadAudit: (): void => {
    window.open(`${API_BASE}/reports/audit.csv`, '_blank')
  },
}

// LINE Bot API
export const lineBotApi = {
  status: (): Promise<LineBotStatus> =>
    fetchJson<LineBotStatus>(`${API_BASE}/line-bot/status`),

  login: (): Promise<LineBotStatus> =>
    fetchJson<LineBotStatus>(`${API_BASE}/line-bot/login`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  send: (input: LineBotSendInput): Promise<LineBotSendResult> =>
    fetchJson<LineBotSendResult>(`${API_BASE}/line-bot/send`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  getGroups: (): Promise<LineBotGroupList> =>
    fetchJson<LineBotGroupList>(`${API_BASE}/line-bot/groups`),

  getProfile: (): Promise<{ displayName: string; mid: string; statusMessage?: string; pictureUrl?: string }> =>
    fetchJson(`${API_BASE}/line-bot/profile`),

  getStorage: (): Promise<{ storagePath: string; exists: boolean; sizeBytes: number; hasE2EEKeys: boolean; hasAuthState: boolean }> =>
    fetchJson(`${API_BASE}/line-bot/storage`),

  logout: (clearStorage = false): Promise<{ loggedOut: boolean; clearStorage: boolean }> =>
    fetchJson(`${API_BASE}/line-bot/logout`, {
      method: 'POST',
      body: JSON.stringify({ clearStorage }),
    }),
}

export const lineImageExtractionApi = {
  paginated: (params?: LineImageExtractionQuery): Promise<ApiPaginatedResponse<LineImageExtraction>> => {
    const query = buildQuery({
      page: params?.page,
      pageSize: params?.pageSize,
      search: params?.search,
      agency: params?.agency,
      tripNumber: params?.tripNumber,
      route: params?.route,
      vehicleType: params?.vehicleType,
      driver: params?.driver,
      createdFrom: params?.createdFrom,
      createdTo: params?.createdTo,
      month: params?.month,
      sortBy: params?.sortBy,
      sortDir: params?.sortDir,
    })
    return fetchPaginated<LineImageExtraction>(`${API_BASE}/line-image-extractions${query ? `?${query}` : ''}`)
  },
}

export const aiApi = {
  codexAuthStatus: (): Promise<CodexDeviceAuthStatus> =>
    fetchJson<CodexDeviceAuthStatus>(`${API_BASE}/ai/codex-auth/status`),

  codexAuthStart: (input: { mode: 'browser' | 'device' }): Promise<CodexDeviceAuthStart> =>
    fetchJson<CodexDeviceAuthStart>(`${API_BASE}/ai/codex-auth/start`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  codexAuthComplete: (input: { callbackUrl?: string; code?: string }): Promise<CodexDeviceAuthComplete> =>
    fetchJson<CodexDeviceAuthComplete>(`${API_BASE}/ai/codex-auth/complete`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  codexAuthLogout: (): Promise<{ loggedOut: boolean }> =>
    fetchJson<{ loggedOut: boolean }>(`${API_BASE}/ai/codex-auth/logout`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
}
