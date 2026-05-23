import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Breadcrumb, type BreadcrumbItem } from '../Breadcrumb'

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
    /** Page title — required. Rendered as h1. */
    title: React.ReactNode
    /** Subtitle / supporting copy under the title. */
    subtitle?: React.ReactNode
    /** Leading icon. Drawn inside a soft brand chip. */
    icon?: LucideIcon
    /** Breadcrumb trail. If omitted, only the home item is implied. */
    breadcrumbs?: BreadcrumbItem[]
    /** Status pills, counters, badges shown inline at the right of the title. */
    meta?: React.ReactNode
    /** Primary / secondary actions (buttons). Right-aligned on desktop. */
    actions?: React.ReactNode
    /** Extra content below the header (filter rail, tabs, etc.). */
    children?: React.ReactNode
    /** Sticky on scroll. Defaults to false to avoid covering content unexpectedly. */
    sticky?: boolean
}

/**
 * Standard page header used across every authenticated route.
 *
 * Lays out four bands:
 *   1. Breadcrumb (optional)
 *   2. Title row — icon + h1 + meta + actions
 *   3. Subtitle (optional)
 *   4. Children — filters, tabs, etc.
 *
 * Designed for both desktop (single horizontal row) and mobile (stacked).
 */
export function PageHeader({
    title,
    subtitle,
    icon: Icon,
    breadcrumbs,
    meta,
    actions,
    children,
    sticky = false,
    className,
    ...rest
}: PageHeaderProps) {
    return (
        <header
            className={cn(
                'mb-4 flex flex-col gap-3 page-enter',
                sticky && 'sticky top-0 z-[var(--z-sticky)] -mx-4 px-4 py-3 lg:-mx-8 lg:px-8 glass border-b border-white/[0.06]',
                className
            )}
            {...rest}
        >
            {breadcrumbs && breadcrumbs.length > 0 ? (
                <Breadcrumb items={breadcrumbs} />
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3 min-w-0">
                    {Icon ? (
                        <span
                            aria-hidden="true"
                            className="hidden sm:inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"
                        >
                            <Icon className="h-[18px] w-[18px]" />
                        </span>
                    ) : null}
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                                {title}
                            </h1>
                            {meta ? (
                                <div className="flex flex-wrap items-center gap-1.5">{meta}</div>
                            ) : null}
                        </div>
                        {subtitle ? (
                            <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
                        ) : null}
                    </div>
                </div>

                {actions ? (
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        {actions}
                    </div>
                ) : null}
            </div>

            {children}
        </header>
    )
}

export default PageHeader
