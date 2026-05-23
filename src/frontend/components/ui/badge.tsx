import { cn } from '../../lib/utils'

/**
 * Semantic-only badge variants.
 *
 * The previous palette (cyan, emerald, amber, rose, violet, slate) is kept as
 * aliases that resolve to semantic tokens, so existing call sites keep working
 * while we migrate JSX to use the semantic names directly.
 */
const variants = {
  default: 'border-[color:var(--color-neutral-border)] bg-[color:var(--color-neutral-soft)] text-muted-foreground',
  primary: 'border-primary/22 bg-primary/10 text-primary',
  accent: 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info',
  info: 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info',
  success: 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success',
  warning: 'border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] text-warning',
  danger: 'border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] text-danger',
  neutral: 'border-[color:var(--color-neutral-border)] bg-[color:var(--color-neutral-soft)] text-muted-foreground',

  // ---- Legacy aliases (resolve to semantic tokens) ----
  emerald: 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success',
  amber: 'border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] text-warning',
  rose: 'border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] text-danger',
  cyan: 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info',
  slate: 'border-[color:var(--color-neutral-border)] bg-[color:var(--color-neutral-soft)] text-muted-foreground',
  violet: 'border-primary/22 bg-primary/10 text-primary',
} as const

type BadgeVariant = keyof typeof variants

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

function Badge({ variant = 'default', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.12em] whitespace-nowrap',
        variants[variant],
        className
      )}
      {...props}
    />
  )
}

export { Badge }
export type { BadgeVariant }
