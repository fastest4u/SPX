import { cn } from '../../lib/utils'
import type { DashboardStatusTone } from '../../lib/dashboard-runtime-state'

const dotTone: Record<DashboardStatusTone, string> = {
  live: 'bg-emerald-500',
  paused: 'bg-amber-400',
  off: 'bg-zinc-500',
  error: 'bg-rose-500',
  unknown: 'bg-zinc-500',
}

const labelTone: Record<DashboardStatusTone, string> = {
  live: 'text-foreground',
  paused: 'text-amber-300',
  off: 'text-muted-foreground',
  error: 'text-rose-300',
  unknown: 'text-muted-foreground',
}

export interface StatusIndicatorProps {
  tone: DashboardStatusTone
  label: string
  /** Relative age, e.g. "3 วินาทีที่แล้ว". Hidden when empty. */
  age?: string | null
  /** Full explanation shown as a native tooltip and to screen readers. */
  detail?: string
  className?: string
}

/** Minimal "dot + label · age" status. One status, no pill chrome. */
export function StatusIndicator({ tone, label, age, detail, className }: StatusIndicatorProps) {
  return (
    <span
      role="status"
      title={detail}
      aria-label={detail ? `${label}: ${detail}` : label}
      className={cn('inline-flex min-w-0 items-center gap-2 text-sm', className)}
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        {tone === 'live' ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        ) : null}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', dotTone[tone])} />
      </span>
      <span className={cn('truncate font-medium', labelTone[tone])}>{label}</span>
      {age ? (
        <>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          {/* Ticks every few seconds; keep it out of the live region to avoid repeated announcements. */}
          <span className="whitespace-nowrap text-muted-foreground tabular-nums" aria-hidden="true">{age}</span>
        </>
      ) : null}
    </span>
  )
}

export default StatusIndicator
