import type {
  LoginResponse,
  MeResponse,
  NotifyRule,
  RuleInput,
  RulePatch,
  BookingHistory,
  HistoryFilterQuery,
  PaginatedHistory,
  AuditLog,
  AuditQuery,
  User,
  CreateUserInput,
  PasswordInput,
  RoleInput,
  EnvSettings,
  MetricsSnapshot,
  MetricsHistoryRow,
  HealthResponse,
  ReadyResponse,
  AcceptBookingInput,
  AcceptBookingResponse,
  NotificationPreview,
  NotificationTestResult,
  ApiError,
} from '../types'

const API_BASE = '/api'

/** Flag to prevent multiple simultaneous 401 redirects */
let isRedirectingToLogin = false

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  // Global 401 handler — redirect to login immediately, don't retry
  if (response.status === 401) {
    // Skip redirect if we're already on login page or already redirecting
    const isLoginRequest = url.includes('/login') || url.includes('/me')
    if (!isLoginRequest && !isRedirectingToLogin) {
      isRedirectingToLogin = true
      window.location.replace('/login')
    }

    const data = await response.json().catch(() => ({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }))
    const error = (data as ApiError).error || { code: 'UNAUTHORIZED', message: 'Session expired' }
    throw new AuthError(`${error.code}: ${error.message}`)
  }

  const data = await response.json()

  if (!response.ok) {
    const error = (data as ApiError).error || { code: 'UNKNOWN', message: 'Unknown error' }
    throw new Error(`${error.code}: ${error.message}`)
  }

  return data as T
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

  logout: (): Promise<{ ok: boolean }> =>
    fetchJson<{ ok: boolean }>(`${API_BASE}/logout`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  refresh: (): Promise<{ ok: boolean }> =>
    fetchJson<{ ok: boolean }>(`${API_BASE}/refresh`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  me: (): Promise<MeResponse> =>
    fetchJson<MeResponse>(`${API_BASE}/me`),
}

// Rules API
export const rulesApi = {
  list: (): Promise<NotifyRule[]> =>
    fetchJson<NotifyRule[]>(`${API_BASE}/rules`),

  get: (id: string): Promise<NotifyRule> =>
    fetchJson<NotifyRule>(`${API_BASE}/rules/${id}`),

  create: (rule: RuleInput): Promise<{ ok: boolean }> =>
    fetchJson<{ ok: boolean }>(`${API_BASE}/rules`, {
      method: 'POST',
      body: JSON.stringify(rule),
    }),

  update: (id: string, patch: RulePatch): Promise<{ ok: boolean }> =>
    fetchJson<{ ok: boolean }>(`${API_BASE}/rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  delete: (id: string): Promise<{ ok: boolean }> =>
    fetchJson<{ ok: boolean }>(`${API_BASE}/rules/${id}`, {
      method: 'DELETE',
    }),
}

// History API
export const historyApi = {
  list: (params?: HistoryFilterQuery): Promise<BookingHistory[]> => {
    const queryParams = new URLSearchParams()
    if (params?.limit) queryParams.set('limit', String(params.limit))
    if (params?.search) queryParams.set('search', params.search)
    if (params?.origin) queryParams.set('origin', params.origin)
    if (params?.destination) queryParams.set('destination', params.destination)
    if (params?.vehicleType) queryParams.set('vehicleType', params.vehicleType)
    if (params?.sortBy) queryParams.set('sortBy', params.sortBy)
    if (params?.sortDir) queryParams.set('sortDir', params.sortDir)

    const query = queryParams.toString()
    return fetchJson<BookingHistory[]>(`${API_BASE}/history${query ? `?${query}` : ''}`)
  },

  paginated: (params?: HistoryFilterQuery): Promise<PaginatedHistory> => {
    const queryParams = new URLSearchParams()
    if (params?.page) queryParams.set('page', String(params.page))
    if (params?.pageSize) queryParams.set('pageSize', String(params.pageSize))
    if (params?.search) queryParams.set('search', params.search)
    if (params?.origin) queryParams.set('origin', params.origin)
    if (params?.destination) queryParams.set('destination', params.destination)
    if (params?.vehicleType) queryParams.set('vehicleType', params.vehicleType)
    if (params?.sortBy) queryParams.set('sortBy', params.sortBy)
    if (params?.sortDir) queryParams.set('sortDir', params.sortDir)

    const query = queryParams.toString()
    return fetchJson<PaginatedHistory>(`${API_BASE}/history/paginated${query ? `?${query}` : ''}`)
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

// Users API
export const usersApi = {
  list: (): Promise<User[]> =>
    fetchJson<User[]>(`${API_BASE}/users`),

  create: (user: CreateUserInput): Promise<{ ok: boolean }> =>
    fetchJson<{ ok: boolean }>(`${API_BASE}/users`, {
      method: 'POST',
      body: JSON.stringify(user),
    }),

  updatePassword: (id: number, password: string): Promise<{ ok: boolean }> =>
    fetchJson<{ ok: boolean }>(`${API_BASE}/users/${id}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password } as PasswordInput),
    }),

  updateRole: (id: number, role: 'user' | 'admin'): Promise<{ ok: boolean }> =>
    fetchJson<{ ok: boolean }>(`${API_BASE}/users/${id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role } as RoleInput),
    }),

  delete: (id: number): Promise<{ ok: boolean }> =>
    fetchJson<{ ok: boolean }>(`${API_BASE}/users/${id}`, {
      method: 'DELETE',
    }),
}

// Settings API
export const settingsApi = {
  get: (): Promise<EnvSettings> =>
    fetchJson<EnvSettings>(`${API_BASE}/settings`),

  update: (settings: EnvSettings): Promise<{ ok: boolean; message?: string }> =>
    fetchJson<{ ok: boolean; message?: string }>(`${API_BASE}/settings`, {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
}

// Metrics API
export const metricsApi = {
  snapshot: (): Promise<MetricsSnapshot> =>
    fetchJson<MetricsSnapshot>('/metrics'),

  history: (limit?: number): Promise<MetricsHistoryRow[]> =>
    fetchJson<MetricsHistoryRow[]>(`/metrics/history${limit ? `?limit=${limit}` : ''}`),
}

// Health/Ready API
export const healthApi = {
  health: (): Promise<HealthResponse> =>
    fetchJson<HealthResponse>('/health'),

  ready: (): Promise<ReadyResponse> =>
    fetchJson<ReadyResponse>('/ready'),
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
