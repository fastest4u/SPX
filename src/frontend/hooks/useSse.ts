import { useEffect, useRef, useState, useCallback } from 'react'
import type { MetricsSnapshot } from '../types'

type SseStatus = 'connecting' | 'connected' | 'disconnected'

interface SseState {
  status: SseStatus
  data: MetricsSnapshot | null
  error: Error | null
}

const SSE_RECONNECT_MS = 5000

export function useSse(url: string, enabled: boolean = true) {
  const [state, setState] = useState<SseState>({
    status: 'connecting',
    data: null,
    error: null,
  })
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)

  const connect = useCallback(() => {
    if (!enabled || !isMountedRef.current) return

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }

    setState((prev: SseState) => ({ ...prev, status: 'connecting' }))

    const es = new EventSource(url)
    eventSourceRef.current = es

    es.onopen = () => {
      if (!isMountedRef.current) return
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

    es.onerror = () => {
      if (!isMountedRef.current) return
      setState((prev: SseState) => ({ ...prev, status: 'disconnected' }))

      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }

      // Schedule reconnect
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      reconnectTimerRef.current = setTimeout(() => {
        if (isMountedRef.current && enabled) {
          connect()
        }
      }, SSE_RECONNECT_MS)
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

    if (enabled) {
      connect()
    }

    return () => {
      isMountedRef.current = false
      disconnect()
    }
  }, [connect, disconnect, enabled])

  const reconnect = useCallback(() => {
    disconnect()
    connect()
  }, [connect, disconnect])

  return {
    ...state,
    reconnect,
  }
}
