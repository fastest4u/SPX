import * as React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from './button'
import { cn } from '../../lib/utils'

export interface ErrorStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
    title?: React.ReactNode
    description?: React.ReactNode
    /** Optional Error object — its message is shown inside a collapsible details block. */
    error?: unknown
    /** Retry handler. Renders a primary action button when provided. */
    onRetry?: () => void
    /** Retry button label. */
    retryLabel?: React.ReactNode
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (error == null) return ''
    try {
        return JSON.stringify(error, null, 2)
    } catch {
        return String(error)
    }
}

/**
 * Page / section level error state. Use when a query fails or an action
 * cannot complete. Pair with `<EmptyState>` for empty-without-error cases
 * and `<Skeleton>` for loading.
 */
export function ErrorState({
    title = 'เกิดข้อผิดพลาด',
    description = 'โหลดข้อมูลไม่สำเร็จ ลองอีกครั้งหรือดูรายละเอียดด้านล่าง',
    error,
    onRetry,
    retryLabel = 'ลองใหม่',
    className,
    ...rest
}: ErrorStateProps) {
    const detailMessage = getErrorMessage(error)
    return (
        <div
            role="alert"
            className={cn(
                'flex flex-col items-center justify-center gap-3 rounded-xl border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] px-5 py-12 text-center',
                className
            )}
            {...rest}
        >
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)]">
                <AlertTriangle className="h-6 w-6 text-danger" />
            </div>
            <div className="max-w-md space-y-1">
                <h3 className="text-base font-semibold text-foreground">{title}</h3>
                {description ? (
                    <p className="text-sm text-muted-foreground">{description}</p>
                ) : null}
            </div>
            {onRetry ? (
                <Button variant="outline" size="sm" onClick={onRetry}>
                    <RefreshCw className="h-4 w-4" />
                    {retryLabel}
                </Button>
            ) : null}
            {detailMessage ? (
                <details className="mt-2 w-full max-w-md text-left">
                    <summary className="cursor-pointer text-xs font-semibold text-muted-foreground hover:text-foreground">
                        แสดงรายละเอียดเชิงเทคนิค
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-white/10 bg-black/30 p-3 text-xs leading-5 text-muted-foreground">
                        {detailMessage}
                    </pre>
                </details>
            ) : null}
        </div>
    )
}
