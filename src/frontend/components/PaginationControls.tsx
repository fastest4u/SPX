import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from './ui/button'

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

export interface PaginationControlsProps {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  className?: string
  variant?: 'responsive' | 'mobile' | 'desktop'
}

function pageRange(page: number, pageSize: number, totalItems: number) {
  if (totalItems <= 0) return '0 รายการ'
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, totalItems)
  return `${start}-${end} จาก ${totalItems.toLocaleString()} รายการ`
}

function getPageNumbers(page: number, totalPages: number) {
  const pages: number[] = []
  let start = Math.max(1, page - 2)
  if (start + 4 > totalPages) {
    start = Math.max(1, totalPages - 4)
  }
  for (let i = 0; i < 5; i++) {
    const p = start + i
    if (p <= totalPages && p > 0) pages.push(p)
  }
  return pages
}

export function PaginationControls({
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
  className,
  variant = 'responsive',
}: PaginationControlsProps) {
  const showMobile = variant === 'responsive' || variant === 'mobile'
  const showDesktop = variant === 'responsive' || variant === 'desktop'

  return (
    <div className={cn('space-y-3', className)}>
      {showMobile ? (
        <MobilePaginationPanel
          className={variant === 'responsive' ? 'sm:hidden' : undefined}
          page={page}
          pageSize={pageSize}
          totalItems={totalItems}
          totalPages={totalPages}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      ) : null}

      {showDesktop ? (
        <DesktopPaginationPanel
          className={variant === 'responsive' ? 'hidden sm:flex' : undefined}
          page={page}
          pageSize={pageSize}
          totalItems={totalItems}
          totalPages={totalPages}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      ) : null}
    </div>
  )
}

function PageSizeSelect({
  pageSize,
  onPageSizeChange,
  className,
}: {
  pageSize: number
  onPageSizeChange: (pageSize: number) => void
  className?: string
}) {
  return (
    <select
      className={cn('rounded-md border border-white/10 bg-black/20 px-2 py-1 text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background', className)}
      value={pageSize}
      onChange={(event) => onPageSizeChange(Number(event.target.value))}
    >
      {PAGE_SIZE_OPTIONS.map((size) => (
        <option key={size} className="bg-popover text-foreground" value={size}>
          {size}
        </option>
      ))}
    </select>
  )
}

function MobilePaginationPanel(props: PaginationControlsProps) {
  const { page, pageSize, totalItems, totalPages, onPageChange, onPageSizeChange, className } = props
  return (
    <div className={className}>
      <div className="rounded-[8px] border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="font-data">{pageRange(page, pageSize, totalItems).replace(' รายการ', '')}</span>
          <label className="flex items-center gap-2">
            <span>แสดง</span>
            <PageSizeSelect
              pageSize={pageSize}
              onPageSizeChange={onPageSizeChange}
              className="text-xs focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </label>
        </div>

        <div className="mt-3 grid grid-cols-[2.5rem_1fr_2.5rem] items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 rounded-[8px] border-white/10 bg-transparent"
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page === 1}
            aria-label="หน้าก่อนหน้า"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-center text-xs font-semibold text-muted-foreground">
            หน้า {page} / {Math.max(1, totalPages)}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 rounded-[8px] border-white/10 bg-transparent"
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page === totalPages || totalPages === 0}
            aria-label="หน้าถัดไป"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function DesktopPaginationPanel(props: PaginationControlsProps) {
  const { page, pageSize, totalItems, totalPages, onPageChange, onPageSizeChange, className } = props
  return (
    <div className={cn('items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-3', className)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>แสดง</span>
        <PageSizeSelect pageSize={pageSize} onPageSizeChange={onPageSizeChange} className="text-sm" />
        <span>รายการต่อหน้า</span>
      </div>

      <div className="flex flex-col items-center gap-4 text-sm text-muted-foreground sm:flex-row">
        <span className="font-data">{pageRange(page, pageSize, totalItems)}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-md border-white/10 bg-transparent"
            onClick={() => onPageChange(1)}
            disabled={page === 1}
            aria-label="หน้าแรก"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-md border-white/10 bg-transparent"
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page === 1}
            aria-label="หน้าก่อนหน้า"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          {getPageNumbers(page, totalPages).map((p) => (
            <Button
              key={p}
              variant={page === p ? 'default' : 'outline'}
              className={cn(
                'h-8 w-8 rounded-md p-0',
                page === p
                  ? 'border-transparent font-bold'
                  : 'border-white/10 bg-transparent text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onPageChange(p)}
              aria-current={page === p ? 'page' : undefined}
            >
              {p}
            </Button>
          ))}

          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-md border-white/10 bg-transparent"
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page === totalPages || totalPages === 0}
            aria-label="หน้าถัดไป"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-md border-white/10 bg-transparent"
            onClick={() => onPageChange(totalPages)}
            disabled={page === totalPages || totalPages === 0}
            aria-label="หน้าสุดท้าย"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
