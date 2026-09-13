import assert from 'node:assert/strict'

type SseMessage = { data: string }
type SseMessageHandler = (event: SseMessage) => void
type DashboardSseEventsModule = {
  decodeSsePayload?: <T>(raw: string) => T
  registerDashboardSseListeners?: (
    addListener: (eventName: string, handler: SseMessageHandler) => void,
    handlers: {
      metrics: SseMessageHandler
      rules: SseMessageHandler
      sessionExpired: SseMessageHandler
    },
  ) => void
  refetchActiveDashboardQueries?: (queryClient: {
    refetchQueries: (
      filters: { type: 'active' },
      options: { throwOnError: true },
    ) => Promise<void>
  }) => Promise<void>
  createDashboardResyncRecovery?: (options: {
    refetch: () => Promise<void>
    onRecovered: () => void
    retryDelayMs?: number
    scheduleRetry?: (callback: () => void, delayMs: number) => () => void
  }) => {
    recover: () => Promise<void>
    cancel: () => void
  }
  decodeMetricsSsePayload?: (raw: string) => unknown | null
  decodeRulesSsePayload?: (raw: string) => unknown | null
  decodeSessionExpiredSsePayload?: (raw: string) => unknown | null
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function main(): Promise<void> {
  let module: DashboardSseEventsModule = {}
  try {
    module = await import('../src/frontend/lib/dashboard-sse-events.js')
  } catch {
    // The RED phase reaches the explicit missing-export assertions below.
  }

  assert.equal(typeof module.decodeSsePayload, 'function')
  assert.equal(typeof module.registerDashboardSseListeners, 'function')
  assert.equal(typeof module.refetchActiveDashboardQueries, 'function')
  assert.equal(typeof module.createDashboardResyncRecovery, 'function')
  assert.equal(typeof module.decodeMetricsSsePayload, 'function')
  assert.equal(typeof module.decodeRulesSsePayload, 'function')
  assert.equal(typeof module.decodeSessionExpiredSsePayload, 'function')

  const decodeSsePayload = module.decodeSsePayload!
  const metricsPayload = { polling: { totalRequests: 12 } }
  assert.deepEqual(decodeSsePayload(JSON.stringify({
    envelopeVersion: 1,
    id: 'metrics.snapshot:team-2:12',
    type: 'metrics.snapshot',
    payloadVersion: 1,
    payload: metricsPayload,
  })), metricsPayload)

  const rulesPayload = [{ id: 'rule-1', name: 'Notify' }]
  assert.deepEqual(decodeSsePayload(JSON.stringify({
    teamId: 2,
    event: 'rules',
    data: rulesPayload,
  })), rulesPayload)

  const sessionPayload = { message: 'expired', timestamp: '2030-01-01T00:00:00.000Z' }
  assert.deepEqual(decodeSsePayload(JSON.stringify(sessionPayload)), sessionPayload)

  const validMetrics = {
    teamId: 2,
    uptime: 10,
    startedAt: '2030-01-01T00:00:00.000Z',
    lastPoll: { timestamp: null, status: null, latencyMs: null, recordCount: null },
    polling: {
      totalRequests: 1,
      successCount: 1,
      errorCount: 0,
      successRate: 100,
      latency: { avg: 1, min: 1, max: 1, p50: 1, p95: 1, p99: 1 },
    },
    session: { isHealthy: true, consecutiveErrors: 0, lastSessionWarning: null },
    database: null,
    data: { totalRecordsSeen: 1, changesDetected: 0, tripsInserted: 0, tripsSkipped: 0 },
    autoAccept: { totalAttempts: 0, successCount: 0, failureCount: 0 },
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
  assert.deepEqual(module.decodeMetricsSsePayload!(JSON.stringify({
    envelopeVersion: 1,
    type: 'metrics.snapshot',
    payload: validMetrics,
  })), validMetrics)

  const validRule = {
    id: 'rule-1',
    name: 'Notify',
    origins: ['BKK'],
    destinations: ['CNX'],
    vehicle_types: ['4WH'],
    need: 1,
    enabled: true,
    fulfilled: false,
    auto_accept: true,
    accept_all: false,
    auto_accepted: false,
  }
  assert.deepEqual(module.decodeRulesSsePayload!(JSON.stringify({
    teamId: 2,
    event: 'rules',
    data: [validRule],
  })), [validRule])
  assert.deepEqual(module.decodeSessionExpiredSsePayload!(JSON.stringify(sessionPayload)), sessionPayload)

  assert.equal(module.decodeMetricsSsePayload!('{not-json'), null)
  assert.equal(module.decodeMetricsSsePayload!(JSON.stringify({ polling: null })), null)
  assert.equal(module.decodeRulesSsePayload!(JSON.stringify({ rules: [] })), null)
  assert.equal(module.decodeRulesSsePayload!(JSON.stringify([{ ...validRule, origins: null }])), null)
  assert.equal(module.decodeSessionExpiredSsePayload!(JSON.stringify({ message: 42, timestamp: null })), null)

  const metricsHandler: SseMessageHandler = () => undefined
  const rulesHandler: SseMessageHandler = () => undefined
  const sessionExpiredHandler: SseMessageHandler = () => undefined
  const registrations: Array<{ eventName: string; handler: SseMessageHandler }> = []
  module.registerDashboardSseListeners!(
    (eventName, handler) => registrations.push({ eventName, handler }),
    {
      metrics: metricsHandler,
      rules: rulesHandler,
      sessionExpired: sessionExpiredHandler,
    },
  )

  assert.deepEqual(registrations.map(({ eventName }) => eventName), [
    'metrics.snapshot',
    'metrics',
    'rules.changed',
    'rules',
    'session.expired',
    'session-expired',
  ])
  assert.equal(registrations[0]?.handler, metricsHandler)
  assert.equal(registrations[1]?.handler, metricsHandler)
  assert.equal(registrations[2]?.handler, rulesHandler)
  assert.equal(registrations[3]?.handler, rulesHandler)
  assert.equal(registrations[4]?.handler, sessionExpiredHandler)
  assert.equal(registrations[5]?.handler, sessionExpiredHandler)

  const refetchCalls: unknown[][] = []
  await module.refetchActiveDashboardQueries!({
    async refetchQueries(...args) {
      refetchCalls.push(args)
    },
  })
  assert.deepEqual(refetchCalls, [[{ type: 'active' }, { throwOnError: true }]])

  const pending = [deferred(), deferred()]
  let refetchIndex = 0
  let recovered = 0
  const overlappingRecovery = module.createDashboardResyncRecovery!({
    refetch: () => pending[refetchIndex++]!.promise,
    onRecovered: () => {
      recovered += 1
    },
  })
  const firstRecovery = overlappingRecovery.recover()
  const secondRecovery = overlappingRecovery.recover()
  pending[0]!.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(recovered, 0, 'an older recovery must not clear a newer resync')
  assert.equal(refetchIndex, 2, 'a newer generation must refetch after the older attempt settles')
  pending[1]!.resolve()
  await Promise.all([firstRecovery, secondRecovery])
  assert.equal(recovered, 1)

  const scheduledRetries: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = []
  let retryRefetches = 0
  let retryRecoveries = 0
  const retryingRecovery = module.createDashboardResyncRecovery!({
    refetch: async () => {
      retryRefetches += 1
      if (retryRefetches === 1) throw new Error('read model unavailable')
    },
    onRecovered: () => {
      retryRecoveries += 1
    },
    retryDelayMs: 250,
    scheduleRetry: (callback, delayMs) => {
      const scheduled = { callback, delayMs, cancelled: false }
      scheduledRetries.push(scheduled)
      return () => {
        scheduled.cancelled = true
      }
    },
  })
  const retryCompletion = retryingRecovery.recover()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(retryRecoveries, 0)
  assert.equal(retryRefetches, 1)
  assert.equal(scheduledRetries.length, 1)
  assert.equal(scheduledRetries[0]?.delayMs, 250)
  scheduledRetries[0]!.callback()
  await retryCompletion
  assert.equal(retryRefetches, 2)
  assert.equal(retryRecoveries, 1)

  const pendingUnmountedRecovery = deferred()
  let unmountedRecoveryAcknowledged = false
  const unmountedRecovery = module.createDashboardResyncRecovery!({
    refetch: () => pendingUnmountedRecovery.promise,
    onRecovered: () => {
      unmountedRecoveryAcknowledged = true
    },
  })
  const recoveryAfterUnmount = unmountedRecovery.recover()
  unmountedRecovery.cancel()
  pendingUnmountedRecovery.resolve()
  await recoveryAfterUnmount
  assert.equal(unmountedRecoveryAcknowledged, false)

  let cancelledTimer = false
  let releaseCancelledRetry: (() => void) | undefined
  const timerCancellationRecovery = module.createDashboardResyncRecovery!({
    refetch: async () => {
      throw new Error('still unavailable')
    },
    onRecovered: () => assert.fail('cancelled recovery must not clear resync'),
    scheduleRetry: (callback) => {
      releaseCancelledRetry = callback
      return () => {
        cancelledTimer = true
      }
    },
  })
  const cancelledRetryCompletion = timerCancellationRecovery.recover()
  await Promise.resolve()
  await Promise.resolve()
  timerCancellationRecovery.cancel()
  assert.equal(cancelledTimer, true)
  releaseCancelledRetry?.()
  await cancelledRetryCompletion

  let freshRecoveryAcknowledged = 0
  const freshRecovery = module.createDashboardResyncRecovery!({
    refetch: async () => undefined,
    onRecovered: () => {
      freshRecoveryAcknowledged += 1
    },
  })
  await freshRecovery.recover()
  assert.equal(freshRecoveryAcknowledged, 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
