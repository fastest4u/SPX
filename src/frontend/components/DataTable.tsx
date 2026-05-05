import { cn } from '../lib/utils'
import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

export interface DataTableColumn<T> {
  header: string
  className?: string
  render: (item: T) => ReactNode
}

export interface PaginationState {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  data: T[]
  keyField: (item: T) => string | number
  emptyIcon?: ReactNode
  emptyMessage?: string
  minWidth?: string
  renderMobile?: (item: T) => ReactNode
  className?: string
  pagination?: PaginationState
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

function getPageNumbers(page: number, totalPages: number) {
  const pages: number[] = []
  let start = Math.max(1, page - 2)
  if (start + 4 > totalPages) {
    start = Math.max(1, totalPages - 4)
  }
  for (let i = 0; i < 5; i++) {
    const p = start + i
    if (p <= totalPages && p > 0) {
      pages.push(p)
    }
  }
  return pages
}

export function DataTable<T>({
  columns,
  data,
  keyField,
  emptyIcon,
  emptyMessage = 'ไม่พบข้อมูล',
  minWidth = '760px',
  renderMobile,
  className,
  pagination,
}: DataTableProps<T>) {
  if (data.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
        {emptyIcon}
        <p>{emptyMessage}</p>
      </div>
    )
  }

  const { page, pageSize, totalItems, totalPages, onPageChange, onPageSizeChange } = pagination || {}

  return (
    <div className={cn('space-y-4', className)}>
      {renderMobile ? (
        <div className="grid gap-3 md:hidden">
          {data.map((item) => (
            <div key={keyField(item)} className="mobile-record">
              {renderMobile(item)}
            </div>
          ))}
        </div>
      ) : null}

      <div className={cn('data-scroll', renderMobile ? 'hidden md:block' : '')}>
        <table className="data-table" style={{ minWidth }}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.header} className={col.className}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((item) => (
              <tr key={keyField(item)}>
                {columns.map((col) => (
                  <td key={col.header} className={col.className}>
                    {col.render(item)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pagination && page !== undefined && pageSize !== undefined && totalItems !== undefined && totalPages !== undefined && onPageChange && onPageSizeChange && (
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row bg-white/[0.03] p-3 rounded-xl border border-white/10">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>แสดง</span>
            <select
              className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm text-slate-200 outline-none focus:border-cyan-400"
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} className="bg-slate-900 text-slate-200" value={size}>
                  {size}
                </option>
              ))}
            </select>
            <span>รายการต่อหน้า</span>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-4 text-sm text-muted-foreground">
            <span>
              {totalItems > 0
                ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, totalItems)} จาก ${totalItems} รายการ`
                : '0 รายการ'}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-md bg-transparent border-white/10"
                onClick={() => onPageChange(1)}
                disabled={page === 1}
              >
                <ChevronsLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-md bg-transparent border-white/10"
                onClick={() => onPageChange(Math.max(1, page - 1))}
                disabled={page === 1}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              {getPageNumbers(page, totalPages).map((p) => (
                <Button
                  key={p}
                  variant={page === p ? 'default' : 'outline'}
                  className={`h-8 w-8 rounded-md p-0 ${
                    page === p
                      ? 'bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 border-transparent font-bold'
                      : 'bg-transparent border-white/10 text-muted-foreground hover:text-white'
                  }`}
                  onClick={() => onPageChange(p)}
                >
                  {p}
                </Button>
              ))}

              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-md bg-transparent border-white/10"
                onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                disabled={page === totalPages || totalPages === 0}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 rounded-md bg-transparent border-white/10"
                onClick={() => onPageChange(totalPages)}
                disabled={page === totalPages || totalPages === 0}
              >
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
