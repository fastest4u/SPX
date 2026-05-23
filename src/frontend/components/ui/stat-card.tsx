import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'

export type StatTone = 'info' | 'success' | 'warning' | 'danger' | 'primary' | 'neutral'

const TONE_CLASSES: Record<StatTone, string> = {
    info: 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info',
    success: 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success',
    warning: 'border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] text-warning',
    danger: 'border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] text-danger',
    primary: 'border-primary/22 bg-primary/10 text-primary',
    neutral: 'border-[color:var(--color-neutral-border)] bg-[color:var(--color-neutral-soft)] text-muted-foreground',
}

export interface StatCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
    /** Short label, uppercase tracked. */
    label: React.ReactNode
    /** Main value — number/string/element. Renders with tabular numerals. */
    value: React.ReactNode
    /** Optional context (units, secondary metric). */
    hint?: React.ReactNode
    /** Optional leading icon, drawn small in the upper-right. */
    icon?: LucideIcon
    /** Trend delta shown as a small pill below the value. */
    delta?: { direction: 'up' | 'down' | 'flat'; label: React.ReactNode }
    /** Visual tone — controls border, soft bg, and accent color. */
    tone?: StatTone
    /** Make the card focusable / clickable. */
    asLink?: boolean
}

const DELTA_TONE: Record<NonNullable<StatCardProps['delta']>['direction'], string> = {
    up: 'text-success',
    down: 'text-danger',
    flat: 'text-muted-foreground',
}

const DELTA_ICON: Record<NonNullable<StatCardProps['delta']>['direction'], LucideIcon> = {
    up: ArrowUpRight,
    down: ArrowDownRight,
    flat: Minus,
}

/**
 * Reusable KPI card. Designed for dashboard, history summary, reports.
 * Memoized internally to avoid re-renders when neighboring cards change.
 */
const StatCardImpl = React.forwardRef<HTMLDivElement, StatCardProps>(function StatCard(
    { label, value, hint, icon: Icon, delta, tone = 'neutral', asLink = false, className, ...rest },
    ref
) {
    const DeltaIcon = delta ? DELTA_ICON[delta.direction] : null
    const sharedClass = cn(
        'group relative flex flex-col gap-2 rounded-xl border px-3.5 py-3 transition-colors',
        TONE_CLASSES[tone],
        asLink && 'cursor-pointer hover:brightness-110',
        className
    )
    const inner = (
        <>
            <div className="flex items-start justify-between gap-2">
                <span className="text-[0.6rem] font-bold uppercase tracking-[0.16em] opacity-70">
                    {label}
                </span>
                {Icon ? <Icon aria-hidden="true" className="h-4 w-4 opacity-70" /> : null}
            </div>
            <div className="font-data text-xl font-black tracking-tight leading-none">{value}</div>
            <div className="flex items-center justify-between gap-2 text-[0.7rem]">
                {hint ? <span className="opacity-70">{hint}</span> : <span aria-hidden="true">&nbsp;</span>}
                {delta && DeltaIcon ? (
                    <span className={cn('inline-flex items-center gap-0.5 font-semibold', DELTA_TONE[delta.direction])}>
                        <DeltaIcon className="h-3 w-3" />
                        {delta.label}
                    </span>
                ) : null}
            </div>
        </>
    )

    if (asLink) {
        return (
            <a
                ref={ref as React.Ref<HTMLAnchorElement>}
                className={sharedClass}
                {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
            >
                {inner}
            </a>
        )
    }

    return (
        <div ref={ref} className={sharedClass} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
            {inner}
        </div>
    )
})

export const StatCard = React.memo(StatCardImpl)
