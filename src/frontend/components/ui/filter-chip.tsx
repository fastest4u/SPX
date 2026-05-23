import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface FilterChipProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'onClick'> {
    /** Field label, e.g. "ต้นทาง". */
    label: React.ReactNode
    /** Active value. */
    value: React.ReactNode
    /** Called when the user clears this chip. */
    onClear?: () => void
    /** Visual tone. Defaults to info. */
    tone?: 'info' | 'success' | 'warning' | 'danger' | 'primary' | 'neutral'
}

const TONE_CLASSES: Record<NonNullable<FilterChipProps['tone']>, string> = {
    info: 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info',
    success: 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success',
    warning: 'border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] text-warning',
    danger: 'border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] text-danger',
    primary: 'border-primary/22 bg-primary/10 text-primary',
    neutral: 'border-[color:var(--color-neutral-border)] bg-[color:var(--color-neutral-soft)] text-muted-foreground',
}

/**
 * Active filter pill. Use in a row above a results table to surface
 * applied filters and let users dismiss them individually.
 */
export function FilterChip({
    label,
    value,
    onClear,
    tone = 'info',
    className,
    ...rest
}: FilterChipProps) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs',
                TONE_CLASSES[tone],
                className
            )}
            {...rest}
        >
            <span className="font-semibold opacity-80">{label}:</span>
            <span className="font-semibold">{value}</span>
            {onClear ? (
                <button
                    type="button"
                    onClick={onClear}
                    aria-label={`ลบตัวกรอง ${typeof label === 'string' ? label : ''}`}
                    className="ml-1 inline-flex items-center justify-center rounded-full p-0.5 hover:bg-white/10 hover:text-foreground"
                >
                    <X className="h-3 w-3" />
                </button>
            ) : null}
        </span>
    )
}
