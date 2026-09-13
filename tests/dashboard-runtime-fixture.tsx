import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { DashboardComponent } from '../src/frontend/routes/index'
import type { AuthUser, MetricsSnapshot, ProviderAuthStatus, Team } from '../src/frontend/types'
import '../src/frontend/index.css'

type Scenario =
  | 'fresh'
  | 'near-stale'
  | 'stopped'
  | 'runtime-recovery'
  | 'stale'
  | 'missing'
  | 'paused'
  | 'poll-error'
  | 'session-expired'
  | 'mismatched'
  | 'disabled'
  | 'admin'

const user: AuthUser = { id: 11, username: 'ptwl-user', role: 'user', teamId: 7 }
const admin: AuthUser = { id: 1, username: 'admin', role: 'admin', teamId: null }
const team: Team = {
  id: 7,
  name: 'PTWL',
  enabled: true,
  hasSpxCookie: true,
  hasSpxDeviceId: true,
  hasLineGroupId: true,
  hasAutoAcceptSuccessLineGroupId: true,
  hasAutoAcceptFailureLineGroupId: true,
  spxCookiePreview: '********okie',
  spxDeviceIdPreview: '********vice',
  lineGroupIdPreview: '********line',
  autoAcceptSuccessLineGroupIdPreview: '********good',
  autoAcceptFailureLineGroupIdPreview: '********fail',
  runtimeStatus: 'running',
  usersCount: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

function metrics(overrides: {
  teamId?: number | null
  timestamp?: string | null
  status?: string | null
  isPaused?: boolean
  isHealthy?: boolean
} = {}): MetricsSnapshot {
  return {
    teamId: overrides.teamId === undefined ? team.id : overrides.teamId,
    uptime: 60,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    isPaused: overrides.isPaused ?? false,
    lastPoll: {
      timestamp: overrides.timestamp === undefined ? new Date(Date.now() - 30_000).toISOString() : overrides.timestamp,
      status: overrides.status ?? 'same',
      latencyMs: 120,
      recordCount: 4,
    },
    polling: {
      totalRequests: 1,
      successCount: 1,
      errorCount: 0,
      successRate: 100,
      latency: { avg: 120, min: 120, max: 120, p50: 120, p95: 120, p99: 120 },
    },
    session: { isHealthy: overrides.isHealthy ?? true, consecutiveErrors: 0, lastSessionWarning: null },
    database: null,
    data: { totalRecordsSeen: 4, changesDetected: 0, tripsInserted: 0, tripsSkipped: 0 },
    autoAccept: { totalAttempts: 0, successCount: 0, failureCount: 0 },
    scheduling: { launched: 0, skippedConcurrency: 0, skippedCooldown: 0 },
    upstream: { requests: 1, connections: 1, reuseRatio: 0 },
    operations: {},
    runtime: {
      activeDetailJobs: 0,
      activeDetailBookings: 0,
      detailConcurrency: 4,
      queuedDetailBookings: 0,
      detailQueuePressure: 0,
      sseClients: 1,
    },
  }
}

const providerStatus: ProviderAuthStatus = {
  teamId: team.id,
  email: 'operator@example.test',
  hasPassword: true,
  status: 'connected',
  lastLoginAt: null,
  expiresAt: null,
  errorCode: null,
  retryAt: null,
}

let currentMetricsResponse = metrics()
let currentTeamResponse = team
let currentTeamRequestCount = 0

window.fetch = async (input) => {
  const requestUrl = String(input)
  if (new URL(requestUrl, window.location.href).pathname === '/metrics') return Response.json(currentMetricsResponse)
  if (requestUrl.includes('/provider-auth')) {
    return Response.json({ status: 'success', data: providerStatus })
  }
  if (new URL(requestUrl, window.location.href).pathname === '/api/team') {
    currentTeamRequestCount += 1
    return Response.json({ status: 'success', data: currentTeamResponse })
  }
  return Response.json({ status: 'error', error_code: 'FIXTURE_ONLY', message: 'Unexpected fixture request' }, { status: 404 })
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
queryClient.setQueryData(['auth'], user)
queryClient.setQueryData(['rules'], [])
queryClient.setQueryData(['metrics-history', 60], [])
queryClient.setQueryData(['current-team'], team)
queryClient.setQueryData(['metrics', user.id, user.role, user.teamId], metrics())

function setScenario(scenario: Scenario): void {
  queryClient.setQueryData(['auth'], scenario === 'admin' ? admin : user)
  if (scenario === 'admin') {
    queryClient.removeQueries({ queryKey: ['current-team'], exact: true })
    currentMetricsResponse = metrics({ teamId: null })
    queryClient.setQueryData(['metrics', admin.id, admin.role, null], currentMetricsResponse)
    return
  }

  currentTeamResponse = scenario === 'runtime-recovery' ? { ...team, runtimeStatus: 'running' } : team
  const nextTeam: Team = {
    ...team,
    enabled: scenario !== 'disabled',
    runtimeStatus: scenario === 'stopped' || scenario === 'runtime-recovery' || scenario === 'disabled'
      ? 'stopped'
      : scenario === 'paused'
        ? 'paused'
        : scenario === 'session-expired'
          ? 'session_expired'
          : 'running',
  }
  const nextMetrics = scenario === 'stale'
    ? metrics({ timestamp: new Date(Date.now() - 120_001).toISOString() })
    : scenario === 'near-stale'
      ? metrics({ timestamp: new Date(Date.now() - 119_000).toISOString() })
      : scenario === 'missing'
        ? metrics({ timestamp: null })
        : scenario === 'paused'
          ? metrics({ isPaused: true })
          : scenario === 'poll-error'
            ? metrics({ status: 'network', isHealthy: true })
            : scenario === 'session-expired'
              ? metrics({ status: 'same', isHealthy: true })
              : scenario === 'mismatched'
                ? metrics({ teamId: 8 })
                : metrics()

  queryClient.setQueryData(['current-team'], nextTeam)
  currentMetricsResponse = nextMetrics
  queryClient.setQueryData(['metrics', user.id, user.role, user.teamId], nextMetrics)
}

Object.assign(window, {
  __dashboardRuntimeFixture: {
    setScenario,
    getCurrentTeamRequestCount: () => currentTeamRequestCount,
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <main className="px-4 py-5">
        <DashboardComponent />
      </main>
      <Toaster theme="dark" />
    </QueryClientProvider>
  </React.StrictMode>,
)
