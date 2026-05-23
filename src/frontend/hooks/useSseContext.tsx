import * as React from 'react'
import { useSse } from './useSse'
import type { MetricsSnapshot, NotifyRule } from '../types'

type SseStatus = 'connecting' | 'connected' | 'disconnected'

interface SessionExpiredEvent {
    message: string
    timestamp: string
}

interface SseContextValue {
    status: SseStatus
    data: MetricsSnapshot | null
    rules: NotifyRule[] | null
    sessionAlert: SessionExpiredEvent | null
    error: Error | null
    reconnect: () => void
}

const SseContext = React.createContext<SseContextValue | null>(null)

/**
 * Single source of truth for the dashboard's `/events` SSE feed.
 *
 * Mount once near the top of the authenticated tree (`<AppLayout>`) so
 * downstream components can read SSE state without each opening their
 * own EventSource connection.
 */
export function SseProvider({
    url = '/events',
    enabled = true,
    children,
}: {
    url?: string
    enabled?: boolean
    children: React.ReactNode
}) {
    const sse = useSse(url, enabled)
    const value: SseContextValue = {
        status: sse.status,
        data: sse.data,
        rules: sse.rules,
        sessionAlert: sse.sessionAlert,
        error: sse.error,
        reconnect: sse.reconnect,
    }
    return <SseContext.Provider value={value}>{children}</SseContext.Provider>
}

/**
 * Read SSE state from the nearest `<SseProvider>`. Returns a stable null
 * fallback when no provider is mounted (e.g. login page) so callers can
 * always destructure safely.
 */
export function useSseStream(): SseContextValue {
    const ctx = React.useContext(SseContext)
    return (
        ctx ?? {
            status: 'disconnected',
            data: null,
            rules: null,
            sessionAlert: null,
            error: null,
            reconnect: () => { },
        }
    )
}
