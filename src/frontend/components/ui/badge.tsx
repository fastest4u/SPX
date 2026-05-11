import { cn } from '../../lib/utils'

const variants = {
  default: 'border-white/10 bg-white/5 text-muted-foreground',
  primary: 'border-primary/20 bg-primary/10 text-primary',
  accent: 'border-accent/20 bg-accent/10 text-accent',
  emerald: 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200',
  amber: 'border-amber-300/20 bg-amber-300/10 text-amber-200',
  rose: 'border-rose-300/20 bg-rose-300/10 text-rose-200',
  violet: 'border-violet-300/20 bg-violet-300/10 text-violet-200',
  cyan: 'border-cyan-300/20 bg-cyan-300/10 text-cyan-200',
  slate: 'border-slate-300/20 bg-slate-300/10 text-slate-300',
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
