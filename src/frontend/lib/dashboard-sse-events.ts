import type { MetricsSnapshot, NotifyRule } from '../types'

export interface DashboardSseMessage {
  data: string
}

export type DashboardSseMessageHandler = (event: DashboardSseMessage) => void

export interface DashboardSseEventHandlers {
  metrics: DashboardSseMessageHandler
  rules: DashboardSseMessageHandler
  sessionExpired: DashboardSseMessageHandler
}

export interface DashboardQueryRefetcher {
  refetchQueries(
    filters: { type: 'active' },
    options: { throwOnError: true },
  ): Promise<unknown>
}

export interface DashboardResyncRecovery {
  recover(): Promise<void>
  cancel(): void
}

export interface SessionExpiredEvent {
  message: string
  timestamp: string
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function hasFiniteNumbers(value: JsonRecord, keys: readonly string[]): boolean {
  return keys.every((key) => isFiniteNumber(value[key]))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isTimingSummary(value: unknown): boolean {
  return isRecord(value) &&
    hasFiniteNumbers(value, ['count', 'avg', 'min', 'max', 'p50', 'p95', 'p99']) &&
    isNullableNumber(value.lastMs)
}

function isMetricsSnapshot(value: unknown): value is MetricsSnapshot {
  if (!isRecord(value)) return false
  const lastPoll = value.lastPoll
  const polling = value.polling
  const latency = isRecord(polling) ? polling.latency : null
  const session = value.session
  const data = value.data
  const autoAccept = value.autoAccept
  const runtime = value.runtime
  const operations = value.operations
  const database = value.database

  return (value.teamId === null || isFiniteNumber(value.teamId)) &&
    (value.teamName === undefined || typeof value.teamName === 'string') &&
    (value.isPaused === undefined || typeof value.isPaused === 'boolean') &&
    isFiniteNumber(value.uptime) &&
    typeof value.startedAt === 'string' &&
    isRecord(lastPoll) &&
    isNullableString(lastPoll.timestamp) &&
    isNullableString(lastPoll.status) &&
    isNullableNumber(lastPoll.latencyMs) &&
    isNullableNumber(lastPoll.recordCount) &&
    isRecord(polling) &&
    hasFiniteNumbers(polling, ['totalRequests', 'successCount', 'errorCount', 'successRate']) &&
    isRecord(latency) &&
    hasFiniteNumbers(latency, ['avg', 'min', 'max', 'p50', 'p95', 'p99']) &&
    isRecord(session) &&
    typeof session.isHealthy === 'boolean' &&
    isFiniteNumber(session.consecutiveErrors) &&
    isNullableString(session.lastSessionWarning) &&
    (database === null || (isRecord(database) && hasFiniteNumbers(database, [
      'totalConnections',
      'idleConnections',
      'acquiredConnections',
      'queuedRequests',
      'connectionLimit',
    ]))) &&
    isRecord(data) &&
    hasFiniteNumbers(data, ['totalRecordsSeen', 'changesDetected', 'tripsInserted', 'tripsSkipped']) &&
    isRecord(autoAccept) &&
    hasFiniteNumbers(autoAccept, ['totalAttempts', 'successCount', 'failureCount']) &&
    isRecord(operations) &&
    Object.values(operations).every(isTimingSummary) &&
    isRecord(runtime) &&
    hasFiniteNumbers(runtime, [
      'activeDetailJobs',
      'activeDetailBookings',
      'detailConcurrency',
      'queuedDetailBookings',
      'detailQueuePressure',
      'sseClients',
    ])
}

function isNotifyRule(value: unknown): value is NotifyRule {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    (value.teamId === undefined || isFiniteNumber(value.teamId)) &&
    (value.teamName === undefined || typeof value.teamName === 'string') &&
    typeof value.name === 'string' &&
    isStringArray(value.origins) &&
    isStringArray(value.destinations) &&
    isStringArray(value.vehicle_types) &&
    isFiniteNumber(value.need) &&
    typeof value.enabled === 'boolean' &&
    typeof value.fulfilled === 'boolean' &&
    typeof value.auto_accept === 'boolean' &&
    typeof value.accept_all === 'boolean' &&
    typeof value.auto_accepted === 'boolean'
}

function isSessionExpiredEvent(value: unknown): value is SessionExpiredEvent {
  return isRecord(value) &&
    typeof value.message === 'string' &&
    typeof value.timestamp === 'string' &&
    Number.isFinite(Date.parse(value.timestamp))
}

export function decodeSsePayload<T>(raw: string): T {
  const parsed: unknown = JSON.parse(raw)

  if (
    isRecord(parsed) &&
    parsed.envelopeVersion === 1 &&
    typeof parsed.type === 'string' &&
    'payload' in parsed
  ) {
    return parsed.payload as T
  }

  if (
    isRecord(parsed) &&
    typeof parsed.teamId === 'number' &&
    typeof parsed.event === 'string' &&
    'data' in parsed
  ) {
    return parsed.data as T
  }

  return parsed as T
}

function decodeValidatedSsePayload<T>(
  raw: string,
  validate: (value: unknown) => value is T,
): T | null {
  try {
    const payload = decodeSsePayload<unknown>(raw)
    return validate(payload) ? payload : null
  } catch {
    return null
  }
}

export function decodeMetricsSsePayload(raw: string): MetricsSnapshot | null {
  return decodeValidatedSsePayload(raw, isMetricsSnapshot)
}

export function decodeRulesSsePayload(raw: string): NotifyRule[] | null {
  return decodeValidatedSsePayload(
    raw,
    (value): value is NotifyRule[] => Array.isArray(value) && value.every(isNotifyRule),
  )
}

export function decodeSessionExpiredSsePayload(raw: string): SessionExpiredEvent | null {
  return decodeValidatedSsePayload(raw, isSessionExpiredEvent)
}

export function registerDashboardSseListeners(
  addListener: (eventName: string, handler: DashboardSseMessageHandler) => void,
  handlers: DashboardSseEventHandlers,
): void {
  for (const eventName of ['metrics.snapshot', 'metrics']) {
    addListener(eventName, handlers.metrics)
  }
  for (const eventName of ['rules.changed', 'rules']) {
    addListener(eventName, handlers.rules)
  }
  for (const eventName of ['session.expired', 'session-expired']) {
    addListener(eventName, handlers.sessionExpired)
  }
}

export async function refetchActiveDashboardQueries(
  queryClient: DashboardQueryRefetcher,
): Promise<void> {
  await queryClient.refetchQueries({ type: 'active' }, { throwOnError: true })
}

export function createDashboardResyncRecovery(options: {
  refetch: () => Promise<void>
  onRecovered: () => void
  retryDelayMs?: number
  scheduleRetry?: (callback: () => void, delayMs: number) => () => void
}): DashboardResyncRecovery {
  const retryDelayMs = options.retryDelayMs ?? 5_000
  const scheduleRetry = options.scheduleRetry ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  })
  let latestGeneration = 0
  let cancelled = false
  let recoveryLoop: Promise<void> | null = null
  let wakeScheduledRetry: (() => void) | null = null

  const waitForRetry = (): Promise<void> => new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      wakeScheduledRetry = null
      resolve()
    }
    const cancelTimer = scheduleRetry(finish, retryDelayMs)
    wakeScheduledRetry = () => {
      cancelTimer()
      finish()
    }
  })

  const runRecoveryLoop = async (): Promise<void> => {
    while (!cancelled) {
      const attemptGeneration = latestGeneration
      try {
        await options.refetch()
      } catch {
        if (cancelled) return
        await waitForRetry()
        continue
      }

      if (cancelled) return
      if (attemptGeneration !== latestGeneration) continue
      options.onRecovered()
      return
    }
  }

  return {
    recover() {
      if (cancelled) return Promise.resolve()
      latestGeneration += 1
      wakeScheduledRetry?.()
      if (!recoveryLoop) {
        const runningLoop = runRecoveryLoop().finally(() => {
          if (recoveryLoop === runningLoop) recoveryLoop = null
        })
        recoveryLoop = runningLoop
      }
      return recoveryLoop
    },
    cancel() {
      cancelled = true
      latestGeneration += 1
      wakeScheduledRetry?.()
    },
  }
}
