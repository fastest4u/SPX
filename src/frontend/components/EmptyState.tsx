import { cn } from '../../lib/utils'
import { Search, FileX, type LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

const iconMap: Record<string, LucideIcon> = {
  search: Search,
  empty: FileX,
}

function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  const IconComp = Icon || FileX

  return (
    <div className={cn('flex flex-col items-center justify-center py-16 px-4 text-center', className)}>
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.02] mb-4">
        <IconComp className="h-8 w-8 text-muted-foreground/40" />
      </div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm text-muted-foreground leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}

export { EmptyState, iconMap }
