import { useQuery } from '@tanstack/react-query'
import { metricsApi } from '../lib/api'
import { DASHBOARD_POLL_FRESHNESS_MS, DASHBOARD_STATUS_CLOCK_INTERVAL_MS } from '../lib/dashboard-runtime-state'
import { useAuth } from './useAuth'
import { useSseStream } from './useSseContext'

/** Dashboard and bell select the same scoped observation; HTTP never refreshes SSE receipt. */
export function useScopedMetrics() {
  const { user } = useAuth()
  const sse = useSseStream()
  const nowMs = sse.observationNowMs
  const teamId = user?.role === 'admin' ? null : user?.teamId
  const hasScope = !!user && (user.role === 'admin' || (typeof teamId === 'number' && Number.isInteger(teamId) && teamId > 0))
  const age = sse.metricsReceivedAt === null ? Infinity : nowMs - sse.metricsReceivedAt
  const freshSse = hasScope && sse.data?.teamId === teamId && age >= -DASHBOARD_STATUS_CLOCK_INTERVAL_MS
    && age < DASHBOARD_POLL_FRESHNESS_MS
  const query = useQuery({
    queryKey: ['metrics', user?.id, user?.role, teamId],
    queryFn: async () => {
      const snapshot = await metricsApi.snapshot()
      if (snapshot.teamId !== teamId) throw new Error('ข้อมูล metrics ไม่ตรงกับทีม')
      return snapshot
    },
    enabled: hasScope && !freshSse,
    staleTime: 5_000,
    refetchInterval: freshSse ? false : 15_000,
  })
  const httpMetrics = hasScope && query.data?.teamId === teamId ? query.data : undefined
  return { ...query, data: freshSse ? sse.data : httpMetrics, hasFreshSse: freshSse }
}
