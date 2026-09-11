export type DashboardFrontendRuntimeEnv = Partial<Record<
  | 'VITE_DASHBOARD_API_BASE_URL'
  | 'VITE_DASHBOARD_READ_MODEL_BASE_URL'
  | 'VITE_DASHBOARD_REALTIME_BASE_URL'
  | 'VITE_DASHBOARD_SSE_PATH'
  | 'VITE_DASHBOARD_METRICS_PATH'
  | 'VITE_DASHBOARD_METRICS_HISTORY_PATH'
  | 'VITE_DASHBOARD_RUNTIME_STATUS_PATH'
  | 'VITE_DASHBOARD_FALLBACK_POLL_MS',
  string | undefined
>>

export interface DashboardFrontendRuntimeConfig {
  apiBaseUrl: string
  readModelBaseUrl: string
  realtimeBaseUrl: string
  ssePath: string
  metricsPath: string
  metricsHistoryPath: string
  runtimeStatusPath: string
  withCredentials: true
  envelopeVersion: 1
  reconnect: {
    initialMs: number
    maxMs: number
    maxRetries: number
  }
  fallbackPollMs: number
}

function configuredString(value: string | undefined, fallback: string): string {
  const normalized = value?.trim()
  return normalized || fallback
}

function configuredFallbackPollMs(value: string | undefined): number {
  const parsed = Number(value?.trim())
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : 60000
}

function configuredApiBaseUrl(value: string | undefined): string {
  const baseUrl = configuredString(value, '/api')
  return baseUrl === '/' ? '' : baseUrl.replace(/\/+$/, '')
}

export function createDashboardFrontendRuntimeConfig(
  env: DashboardFrontendRuntimeEnv,
): DashboardFrontendRuntimeConfig {
  return {
    apiBaseUrl: configuredApiBaseUrl(env.VITE_DASHBOARD_API_BASE_URL),
    readModelBaseUrl: configuredString(env.VITE_DASHBOARD_READ_MODEL_BASE_URL, ''),
    realtimeBaseUrl: configuredString(env.VITE_DASHBOARD_REALTIME_BASE_URL, ''),
    ssePath: configuredString(env.VITE_DASHBOARD_SSE_PATH, '/events'),
    metricsPath: configuredString(env.VITE_DASHBOARD_METRICS_PATH, '/metrics'),
    metricsHistoryPath: configuredString(env.VITE_DASHBOARD_METRICS_HISTORY_PATH, '/metrics/history'),
    runtimeStatusPath: configuredString(env.VITE_DASHBOARD_RUNTIME_STATUS_PATH, '/api/runtime/status'),
    withCredentials: true,
    envelopeVersion: 1,
    reconnect: { initialMs: 5000, maxMs: 60000, maxRetries: 10 },
    fallbackPollMs: configuredFallbackPollMs(env.VITE_DASHBOARD_FALLBACK_POLL_MS),
  }
}

export function resolveDashboardRuntimeUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return path

  const normalizedPath = path.replace(/^\/+/, '')
  if (!baseUrl) return `/${normalizedPath}`

  return `${baseUrl.replace(/\/+$/, '')}/${normalizedPath}`
}

const runtimeEnv = (import.meta as { env?: DashboardFrontendRuntimeEnv }).env

export const dashboardFrontendRuntimeConfig = createDashboardFrontendRuntimeConfig(runtimeEnv ?? {})
