import { useCallback, useEffect, useState } from 'react'

const SCHEMA_VERSION = 1
const STORAGE_PREFIX = 'spx:view:'

interface PersistedEnvelope<T> {
    v: number
    ts: number
    data: T
}

/**
 * Persist a small piece of view state (filters, density, sort, etc.) to
 * `localStorage` under a versioned envelope. State is read once on mount,
 * then written on change. Server-side / private-mode failures are silently
 * ignored — the component still works, just without persistence.
 *
 * Versioning follows the localStorage advice from the Vercel React rules
 * (`client-localstorage-schema`): we store `{v, ts, data}` so a future
 * schema bump can drop the entry instead of crashing on a stale shape.
 */
export function useSavedView<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void, () => void] {
    const storageKey = `${STORAGE_PREFIX}${key}`

    const [value, setValueState] = useState<T>(() => {
        if (typeof window === 'undefined') return initial
        try {
            const raw = window.localStorage.getItem(storageKey)
            if (!raw) return initial
            const parsed = JSON.parse(raw) as PersistedEnvelope<T>
            if (!parsed || parsed.v !== SCHEMA_VERSION) return initial
            return parsed.data
        } catch {
            return initial
        }
    })

    const setValue = useCallback(
        (next: T | ((prev: T) => T)) => {
            setValueState((prev) => {
                const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
                if (typeof window !== 'undefined') {
                    try {
                        const envelope: PersistedEnvelope<T> = {
                            v: SCHEMA_VERSION,
                            ts: Date.now(),
                            data: resolved,
                        }
                        window.localStorage.setItem(storageKey, JSON.stringify(envelope))
                    } catch {
                        // ignore quota / private-mode errors
                    }
                }
                return resolved
            })
        },
        [storageKey]
    )

    const reset = useCallback(() => {
        setValueState(initial)
        if (typeof window !== 'undefined') {
            try {
                window.localStorage.removeItem(storageKey)
            } catch {
                // ignore
            }
        }
        // Intentionally exclude `initial` from deps so callers can pass an inline literal
        // without re-creating the reset function on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey])

    // Keep tabs in sync — listen for storage events from other tabs.
    useEffect(() => {
        if (typeof window === 'undefined') return
        function onStorage(event: StorageEvent) {
            if (event.key !== storageKey) return
            if (event.newValue == null) {
                setValueState(initial)
                return
            }
            try {
                const parsed = JSON.parse(event.newValue) as PersistedEnvelope<T>
                if (parsed?.v === SCHEMA_VERSION) setValueState(parsed.data)
            } catch {
                // ignore
            }
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey])

    return [value, setValue, reset]
}
