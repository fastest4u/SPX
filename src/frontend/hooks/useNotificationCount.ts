import { useQuery } from '@tanstack/react-query'
import { metricsApi } from '../lib/api'

/**
 * Returns the number of items currently warranting an operator's attention.
 *
 * Today the dashboard surfaces three operator-relevant signals:
 *   - SPX session expired / unhealthy
 *   - Polling pipeline paused
 *   - Detail-fetch queue under heavy pressure (> 100%)
 *
 * The hook intentionally aggregates these into a single count so the bell
 * icon in `<AppLayout>` reflects something meaningful instead of being
 * hardcoded to 0. When more notification sources land (alerts feed,
 * unread audit events, etc.) extend this list — keep the boolean shape so
 * each signal stays addressable.
 */
export function useNotificationCount(): number {
    const { data: metrics } = useQuery({
        queryKey: ['metrics'],
        queryFn: metricsApi.snapshot,
        staleTime: 5 * 1000,
        refetchInterval: 15 * 1000,
    })

    if (!metrics) return 0
    const signals = [
        metrics.lastPoll?.status === 'session_expired',
        metrics.session && !metrics.session.isHealthy,
        metrics.isPaused === true,
        (metrics.runtime?.detailQueuePressure ?? 0) > 100,
    ]
    return signals.filter(Boolean).length
}
