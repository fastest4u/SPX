import { useEffect, useRef, useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { decodeMetricsSsePayload } from '../lib/dashboard-sse-events'
import type { MetricsSnapshot, NotifyRule } from '../types'

type SseStatus = 'connecting' | 'connected' | 'disconnected'

interface SseState {
  status: SseStatus
  metricsReceivedAt: number | null
  scopeKey: string
  data: MetricsSnapshot | null
  rules: NotifyRule[] | null
  sessionAlert: SessionExpiredEvent | null
  error: Error | null
}

interface SessionExpiredEvent {
  message: string
  timestamp: string
}

interface TeamSseEvent<T> {
  teamId: number
  event: string
  data: T
}

function unwrapSseData<T>(raw: string): T {
  const parsed = JSON.parse(raw) as T | TeamSseEvent<T>
  if (
    parsed &&
    typeof parsed === 'object' &&
    'teamId' in parsed &&
    'event' in parsed &&
    'data' in parsed
  ) {
    return (parsed as TeamSseEvent<T>).data
  }
  return parsed as T
}

const SSE_INITIAL_RECONNECT_MS = 5000
const SSE_MAX_RECONNECT_MS = 60_000
const SSE_MAX_RETRIES = 10

export function useSse(url: string, enabled: boolean = true, scopeKey = '', expectedMetricsTeamId?: number | null) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<SseState>({
    status: 'connecting',
    metricsReceivedAt: null,
    scopeKey,
    data: null,
    rules: null,
    sessionAlert: null,
    error: null,
  })
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)
  const retriesRef = useRef(0)

  const connect = useCallback(() => {
    if (!enabled || !isMountedRef.current) return

    // Stop reconnecting after max retries
    if (retriesRef.current >= SSE_MAX_RETRIES) {
      setState((prev: SseState) => ({
        ...prev,
        status: 'disconnected',
        error: new Error('Max SSE reconnection attempts reached'),
      }))
      return
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }

    setState((prev: SseState) => ({ ...prev, status: 'connecting' }))

    // withCredentials: true ensures cookies (JWT) are sent with the SSE request
    const es = new EventSource(url, { withCredentials: true })
    eventSourceRef.current = es

    es.onopen = () => {
      if (!isMountedRef.current || eventSourceRef.current !== es) return
      // Reset retry counter on successful connection
      retriesRef.current = 0
      setState((prev: SseState) => ({ ...prev, status: 'connected', error: null }))
    }

    const onMetrics = (event: MessageEvent<string>) => {
      if (!isMountedRef.current || eventSourceRef.current !== es) return
      try {
        const data = decodeMetricsSsePayload(event.data)
        if (!data || data.teamId !== expectedMetricsTeamId) return
        const envelope = JSON.parse(event.data)
        const envelopeTeamId = envelope.scope?.kind === 'team' ? envelope.scope.teamId : envelope.teamId
        if (typeof envelopeTeamId === 'number' && data.teamId !== envelopeTeamId) return
        setState((prev: SseState) => ({ ...prev, data, metricsReceivedAt: Date.now(), scopeKey }))
      } catch (error) {
        console.error('Failed to parse SSE metrics data:', error)
      }
    }
    es.addEventListener('metrics', onMetrics)
    es.addEventListener('metrics.snapshot', onMetrics)

    es.addEventListener('rules', (event) => {
      if (!isMountedRef.current || eventSourceRef.current !== es) return
      try {
        const rules = unwrapSseData<NotifyRule[]>(event.data)
        setState((prev: SseState) => ({ ...prev, rules }))
      } catch (error) {
        console.error('Failed to parse SSE rules data:', error)
      }
    })

    es.addEventListener('session-expired', (event) => {
      if (!isMountedRef.current || eventSourceRef.current !== es) return
      try {
        const sessionAlert = unwrapSseData<SessionExpiredEvent>(event.data)
        setState((prev: SseState) => ({ ...prev, sessionAlert, status: 'disconnected' }))
      } catch (error) {
        console.error('Failed to parse SSE session-expired data:', error)
      }
      // Session is gone: invalidate auth state and stop reconnecting against
      // the now-rejecting endpoint.
      void queryClient.invalidateQueries({ queryKey: ['auth'] })
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
    })

    es.onerror = () => {
      if (!isMountedRef.current || eventSourceRef.current !== es) return

      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }

      retriesRef.current += 1

      // If we've exceeded max retries, give up
      if (retriesRef.current >= SSE_MAX_RETRIES) {
        setState((prev: SseState) => ({
          ...prev,
          status: 'disconnected',
          error: new Error('Max SSE reconnection attempts reached'),
        }))
        return
      }

      setState((prev: SseState) => ({ ...prev, status: 'disconnected' }))

      // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped)
      const backoffMs = Math.min(
        SSE_INITIAL_RECONNECT_MS * Math.pow(2, retriesRef.current - 1),
        SSE_MAX_RECONNECT_MS,
      )

      // Schedule reconnect with backoff
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      reconnectTimerRef.current = setTimeout(() => {
        if (isMountedRef.current && enabled) {
          connect()
        }
      }, backoffMs)
    }
  }, [url, enabled, queryClient, scopeKey, expectedMetricsTeamId])

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
  }, [])

  useEffect(() => {
    isMountedRef.current = true
    retriesRef.current = 0
    setState({ status: 'connecting', data: null, metricsReceivedAt: null, scopeKey, rules: null, sessionAlert: null, error: null })

    if (enabled) {
      connect()
    }

    return () => {
      isMountedRef.current = false
      disconnect()
    }
  }, [connect, disconnect, enabled, scopeKey])

  const reconnect = useCallback(() => {
    retriesRef.current = 0
    disconnect()
    connect()
  }, [connect, disconnect])

  return {
    ...state,
    status: state.scopeKey === scopeKey ? state.status : 'connecting' as const,
    rules: state.scopeKey === scopeKey ? state.rules : null,
    sessionAlert: state.scopeKey === scopeKey ? state.sessionAlert : null,
    error: state.scopeKey === scopeKey ? state.error : null,
    data: state.scopeKey === scopeKey ? state.data : null,
    metricsReceivedAt: state.scopeKey === scopeKey ? state.metricsReceivedAt : null,
    reconnect,
  }
}
