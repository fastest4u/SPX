import type {
  AcceptBookingInput,
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
  CreateUserInput,
  EnvSettings,
  HealthResponse,
  HistoryFilterQuery,
  LoginResponse,
  MeResponse,
  MetricsHistoryRow,
  LineQuota,
  MetricsSnapshot,
  NotifyRule,
  NotificationPreview,
  NotificationTestResult,
  PaginatedHistory,
  PasswordInput,
  ReadyResponse,
  RoleInput,
  RuleInput,
  RulePatch,
  User,
} from '../types'

const API_BASE = '/api'

/** Flag to prevent multiple simultaneous 401 redirects */
let isRedirectingToLogin = false

async function fetchRaw<T>(url: string, options?: RequestInit): Promise<ApiSuccessResponse<T>> {
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

  // Global 401 handler — redirect to login immediately, don't retry
  if (response.status === 401) {
    // Skip redirect if we're already on login page or already redirecting
    const isLoginRequest = url.includes('/login') || url.includes('/me')
    if (!isLoginRequest && !isRedirectingToLogin) {
      isRedirectingToLogin = true
      window.location.replace('/login')
    }

    const errorData = data as ApiErrorResponse
    throw new AuthError(`${errorData.error_code}: ${errorData.message}`)
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

async function fetchPlain<T>(url: string, options?: RequestInit, retries = 3): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        credentials: 'include',
        headers: options?.headers,
      })
      const data = await response.json().catch(() => null) as T | ApiErrorResponse | null
      if (!response.ok) {
        if (response.status >= 500 && attempt < retries - 1) {
          const delayMs = 250 * 2 ** attempt
          await new Promise(resolve => setTimeout(resolve, delayMs))
          continue
        }
        if (data && typeof data === 'object' && 'status' in data && data.status === 'error') {
          throw new Error(`${data.error_code}: ${data.message}`)
        }
        throw new Error(`REQUEST_ERROR: ${response.statusText || 'Request failed'}`)
      }
      return data as T
    } catch (error) {
      lastError = error
      if (attempt < retries - 1) {
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
    const queryParams = new URLSearchParams()
    if (params?.limit) queryParams.set('limit', String(params.limit))
    if (params?.search) queryParams.set('search', params.search)
    if (params?.requestId) queryParams.set('requestId', String(params.requestId))
    if (params?.bookingId) queryParams.set('bookingId', String(params.bookingId))
    if (params?.origin) queryParams.set('origin', params.origin)
    if (params?.destination) queryParams.set('destination', params.destination)
    if (params?.vehicleType) queryParams.set('vehicleType', params.vehicleType)
    if (params?.sortBy) queryParams.set('sortBy', params.sortBy)
    if (params?.sortDir) queryParams.set('sortDir', params.sortDir)

    const query = queryParams.toString()
    return fetchJson<BookingHistory[]>(`${API_BASE}/history${query ? `?${query}` : ''}`)
  },

  paginated: (params?: HistoryFilterQuery): Promise<ApiPaginatedResponse<BookingHistory>> => {
    const queryParams = new URLSearchParams()
    if (params?.page) queryParams.set('page', String(params.page))
    if (params?.pageSize) queryParams.set('pageSize', String(params.pageSize))
    if (params?.search) queryParams.set('search', params.search)
    if (params?.requestId) queryParams.set('requestId', String(params.requestId))
    if (params?.bookingId) queryParams.set('bookingId', String(params.bookingId))
    if (params?.origin) queryParams.set('origin', params.origin)
    if (params?.destination) queryParams.set('destination', params.destination)
    if (params?.vehicleType) queryParams.set('vehicleType', params.vehicleType)
    if (params?.sortBy) queryParams.set('sortBy', params.sortBy)
    if (params?.sortDir) queryParams.set('sortDir', params.sortDir)

    const query = queryParams.toString()
    return fetchPaginated<BookingHistory>(`${API_BASE}/history/paginated${query ? `?${query}` : ''}`)
  },
}

// Audit API
export const auditApi = {
  list: (params?: AuditQuery): Promise<AuditLog[]> => {
    const queryParams = new URLSearchParams()
    if (params?.limit) queryParams.set('limit', String(params.limit))
    if (params?.search) queryParams.set('search', params.search)
    if (params?.username) queryParams.set('username', params.username)
    if (params?.action) queryParams.set('action', params.action)
    if (params?.sortBy) queryParams.set('sortBy', params.sortBy)
    if (params?.sortDir) queryParams.set('sortDir', params.sortDir)

    const query = queryParams.toString()
    return fetchJson<AuditLog[]>(`${API_BASE}/audit-logs${query ? `?${query}` : ''}`)
  },
}

// Auto-Accept History API
export const autoAcceptHistoryApi = {
  list: (params?: AutoAcceptHistoryQuery): Promise<AutoAcceptHistoryItem[]> => {
    const queryParams = new URLSearchParams()
    if (params?.limit) queryParams.set('limit', String(params.limit))
    if (params?.search) queryParams.set('search', params.search)
    if (params?.ruleName) queryParams.set('ruleName', params.ruleName)
    if (params?.status) queryParams.set('status', params.status)
    if (params?.sortBy) queryParams.set('sortBy', params.sortBy)
    if (params?.sortDir) queryParams.set('sortDir', params.sortDir)

    const query = queryParams.toString()
    return fetchJson<AutoAcceptHistoryItem[]>(`${API_BASE}/auto-accept-history${query ? `?${query}` : ''}`)
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

  updateRole: (id: number, role: 'user' | 'admin'): Promise<null> =>
    fetchJson<null>(`${API_BASE}/users/${id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role } as RoleInput),
    }),

  delete: (id: number): Promise<null> =>
    fetchJson<null>(`${API_BASE}/users/${id}`, {
      method: 'DELETE',
    }),
}

// Settings API
export const settingsApi = {
  get: (): Promise<EnvSettings> =>
    fetchJson<EnvSettings>(`${API_BASE}/settings`),

  update: (settings: EnvSettings): Promise<null> =>
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
