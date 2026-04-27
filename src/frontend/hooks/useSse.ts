import { useEffect, useRef, useState, useCallback } from 'react'
import type { MetricsSnapshot, NotifyRule } from '../types'

type SseStatus = 'connecting' | 'connected' | 'disconnected'

interface SseState {
  status: SseStatus
  data: MetricsSnapshot | null
  rules: NotifyRule[] | null
  error: Error | null
}

const SSE_INITIAL_RECONNECT_MS = 5000
const SSE_MAX_RECONNECT_MS = 60_000
const SSE_MAX_RETRIES = 10

export function useSse(url: string, enabled: boolean = true) {
  const [state, setState] = useState<SseState>({
    status: 'connecting',
    data: null,
    rules: null,
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
      if (!isMountedRef.current) return
      // Reset retry counter on successful connection
      retriesRef.current = 0
      setState((prev: SseState) => ({ ...prev, status: 'connected', error: null }))
    }

    es.addEventListener('metrics', (event) => {
      if (!isMountedRef.current) return
      try {
        const data = JSON.parse(event.data) as MetricsSnapshot
        setState((prev: SseState) => ({ ...prev, data }))
      } catch (error) {
        console.error('Failed to parse SSE metrics data:', error)
      }
    })

    es.addEventListener('rules', (event) => {
      if (!isMountedRef.current) return
      try {
        const rules = JSON.parse(event.data) as NotifyRule[]
        setState((prev: SseState) => ({ ...prev, rules }))
      } catch (error) {
        console.error('Failed to parse SSE rules data:', error)
      }
    })

    es.onerror = () => {
      if (!isMountedRef.current) return

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
  }, [url, enabled])

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

    if (enabled) {
      connect()
    }

    return () => {
      isMountedRef.current = false
      disconnect()
    }
  }, [connect, disconnect, enabled])

  const reconnect = useCallback(() => {
    retriesRef.current = 0
    disconnect()
    connect()
  }, [connect, disconnect])

  return {
    ...state,
    reconnect,
  }
}
