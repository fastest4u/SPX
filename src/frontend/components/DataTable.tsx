import { useState, useMemo } from 'react'
import { cn } from '../lib/utils'
import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowUp, ArrowDown } from 'lucide-react'

export interface DataTableColumn<T> {
  header: string
  className?: string
  render: (item: T) => ReactNode
  sortKey?: string
  sortable?: boolean
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

type SortDirection = 'asc' | 'desc' | null

export function DataTable<T>({
  columns,
  data: rawData,
  keyField,
  emptyIcon,
  emptyMessage = 'ไม่พบข้อมูล',
  minWidth = '760px',
  renderMobile,
  className,
  pagination,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDirection>(null)

  const handleSort = (key: string) => {
    if (sortKey === key) {
      if (sortDir === 'asc') {
        setSortDir('desc')
      } else if (sortDir === 'desc') {
        setSortKey(null)
        setSortDir(null)
      }
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const data = useMemo(() => {
    if (!sortKey || !sortDir) return rawData
    const col = columns.find(c => c.sortKey === sortKey || c.header === sortKey)
    return [...rawData].sort((a, b) => {
      const aVal = col ? String(col.render(a) ?? '') : String((a as any)[sortKey] ?? '')
      const bVal = col ? String(col.render(b) ?? '') : String((b as any)[sortKey] ?? '')
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rawData, sortKey, sortDir, columns])

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
              {columns.map((col) => {
                const columnSortKey = col.sortKey || col.header
                const isSorted = sortKey === columnSortKey
                const isSortable = col.sortable !== false && Boolean(col.sortKey || col.header)
                return (
                  <th
                    key={col.header}
                    className={cn(
                      col.className,
                      isSortable && 'cursor-pointer select-none hover:text-white transition-colors'
                    )}
                    onClick={isSortable ? () => handleSort(columnSortKey) : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.header}
                      {isSortable && (
                        <span className="inline-flex flex-col -space-y-1">
                          <ArrowUp className={cn('h-2.5 w-2.5', isSorted && sortDir === 'asc' ? 'text-primary' : 'text-muted-foreground/30')} />
                          <ArrowDown className={cn('h-2.5 w-2.5', isSorted && sortDir === 'desc' ? 'text-primary' : 'text-muted-foreground/30')} />
                        </span>
                      )}
                    </span>
                  </th>
                )
              })}
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
              className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm text-slate-200 outline-none focus:border-primary/50"
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
