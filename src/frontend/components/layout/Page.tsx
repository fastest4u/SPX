import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Card, CardContent } from '../ui/card'

export function PageShell({
  children,
  className,
  bottomSafe = false,
}: {
  children: ReactNode
  className?: string
  bottomSafe?: boolean
}) {
  return (
    <div className={cn('min-w-0 max-w-full space-y-5 page-enter sm:space-y-6', bottomSafe && 'pb-24 lg:pb-0', className)}>
      {children}
    </div>
  )
}

export function ContentSection({
  children,
  className,
  contentClassName,
}: {
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <Card className={cn('glass overflow-hidden border-white/10', className)}>
      <CardContent className={cn('p-5 sm:p-6', contentClassName)}>
        {children}
      </CardContent>
    </Card>
  )
}

export function FilterPanel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('mb-6 rounded-[8px] border border-white/10 bg-white/[0.03] p-3 sm:p-4', className)}>
      {children}
    </div>
  )
}

export function MobileRecordCard({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <article className={cn('min-w-0 max-w-full overflow-hidden rounded-[8px] border border-white/[0.06] bg-white/[0.025] p-4', className)}>
      {children}
    </article>
  )
}

export function EmptyPanel({
  icon,
  children,
  className,
}: {
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-xl border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground', className)}>
      {icon}
      <p>{children}</p>
    </div>
  )
}
