import { cn } from '../../lib/utils'
import { ChevronRight, Home } from 'lucide-react'
import { Link } from '@tanstack/react-router'

interface BreadcrumbItem {
  label: string
  path?: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
  className?: string
}

function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn('flex items-center gap-1 text-xs', className)}>
      <Link
        to="/"
        className="flex items-center gap-1 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        <Home className="h-3 w-3" />
      </Link>
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground/30" />
            {item.path && !isLast ? (
              <Link
                to={item.path}
                className="text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              >
                {item.label}
              </Link>
            ) : (
              <span className={cn(isLast ? 'text-white font-medium' : 'text-muted-foreground/60')}>
                {item.label}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  )
}

export { Breadcrumb }
export type { BreadcrumbItem }
