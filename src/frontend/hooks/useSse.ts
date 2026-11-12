import { useEffect, useRef, useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  decodeMetricsSsePayload,
  decodeRulesSsePayload,
  decodeSessionExpiredSsePayload,
  extractSseEnvelopeTeamId,
  matchesExpectedSseTeam,
  registerDashboardSseListeners,
  type DashboardSseMessage,
  type SessionExpiredEvent,
} from '../lib/dashboard-sse-events'
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

    const onMetrics = (event: DashboardSseMessage) => {
      if (!isMountedRef.current || eventSourceRef.current !== es) return
      try {
        const data = decodeMetricsSsePayload(event.data)
        if (!data || data.teamId !== expectedMetricsTeamId) return
        const envelopeTeamId = extractSseEnvelopeTeamId(event.data)
        if (typeof envelopeTeamId === 'number' && data.teamId !== envelopeTeamId) return
        setState((prev: SseState) => ({ ...prev, data, metricsReceivedAt: Date.now(), scopeKey }))
      } catch (error) {
        console.error('Failed to parse SSE metrics data:', error)
      }
    }

    const onRules = (event: DashboardSseMessage) => {
      if (!isMountedRef.current || eventSourceRef.current !== es) return
      if (!matchesExpectedSseTeam(event.data, expectedMetricsTeamId)) return
      const rules = decodeRulesSsePayload(event.data)
      if (!rules) return
      setState((prev: SseState) => ({ ...prev, rules, scopeKey }))
    }

    const onSessionExpired = (event: DashboardSseMessage) => {
      if (!isMountedRef.current || eventSourceRef.current !== es) return
      if (!matchesExpectedSseTeam(event.data, expectedMetricsTeamId)) return
      const sessionAlert = decodeSessionExpiredSsePayload(event.data)
      if (!sessionAlert) return
      setState((prev: SseState) => ({ ...prev, sessionAlert, scopeKey }))
      void queryClient.invalidateQueries({ queryKey: ['current-team'] })
      void queryClient.invalidateQueries({ queryKey: ['provider-auth'] })
    }

    registerDashboardSseListeners(
      (eventName, handler) => {
        es.addEventListener(eventName, (event) => handler(event as MessageEvent<string>))
      },
      {
        metrics: onMetrics,
        rules: onRules,
        sessionExpired: onSessionExpired,
      },
    )

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

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return

    const recoverIfDisconnected = () => {
      if (!isMountedRef.current || !enabled) return
      if (eventSourceRef.current !== null && eventSourceRef.current.readyState !== 2) return
      if (eventSourceRef.current !== null) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
      retriesRef.current = 0
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      connect()
    }

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        recoverIfDisconnected()
      }
    }

    window.addEventListener('online', recoverIfDisconnected)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    return () => {
      window.removeEventListener('online', recoverIfDisconnected)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }
  }, [connect, enabled])

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
