import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import type { ReactNode } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ArrowUp,
  ArrowDown,
  Rows3,
  Rows4,
  Rows2,
  EyeOff,
  Eye,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from './ui/button'

export interface DataTableColumn<T> {
  header: string
  /** Optional persistence id. Falls back to the header. Used by the column-visibility menu. */
  id?: string
  className?: string
  render: (item: T) => ReactNode
  sortKey?: string
  sortable?: boolean
  /** When true, the user cannot hide this column from the visibility menu. */
  required?: boolean
  /** Initial visibility. Defaults to true. */
  defaultVisible?: boolean
}

export interface PaginationState {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

export type DataTableDensity = 'compact' | 'cozy' | 'comfortable'

export interface BulkAction<T> {
  label: ReactNode
  onClick: (selected: T[], clear: () => void) => void
  variant?: 'default' | 'destructive' | 'outline' | 'ghost'
  icon?: ReactNode
  disabled?: (selected: T[]) => boolean
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
  sorting?: {
    sortKey: string | null
    sortDir: SortDirection
    onSortChange: (sortKey: string | null, sortDir: SortDirection) => void
  }
  /** Initial density. Defaults to "cozy". User toggle persists in localStorage when `densityKey` is set. */
  defaultDensity?: DataTableDensity
  /** Persistence key for density toggle + column visibility. Stored under `spx:table:<key>`. */
  densityKey?: string
  /** When provided, enables row selection + bulk action toolbar. */
  bulkActions?: BulkAction<T>[]
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]
const DENSITY_NEXT: Record<DataTableDensity, DataTableDensity> = {
  compact: 'cozy',
  cozy: 'comfortable',
  comfortable: 'compact',
}
const DENSITY_LABEL: Record<DataTableDensity, string> = {
  compact: 'หนาแน่น',
  cozy: 'ปกติ',
  comfortable: 'โปร่ง',
}
const DENSITY_ICON: Record<DataTableDensity, typeof Rows2> = {
  compact: Rows2,
  cozy: Rows3,
  comfortable: Rows4,
}

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

function readDensity(densityKey: string | undefined, fallback: DataTableDensity): DataTableDensity {
  if (typeof window === 'undefined' || !densityKey) return fallback
  try {
    const raw = window.localStorage.getItem(`spx:density:${densityKey}`)
    if (raw === 'compact' || raw === 'cozy' || raw === 'comfortable') return raw
  } catch {
    // ignore quota / private mode
  }
  return fallback
}

function readHiddenColumns(densityKey: string | undefined): Set<string> {
  if (typeof window === 'undefined' || !densityKey) return new Set()
  try {
    const raw = window.localStorage.getItem(`spx:tablecols:${densityKey}`)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as { v: number; hidden: string[] } | null
    if (parsed && parsed.v === 1 && Array.isArray(parsed.hidden)) {
      return new Set(parsed.hidden)
    }
  } catch {
    // ignore
  }
  return new Set()
}

function writeHiddenColumns(densityKey: string | undefined, hidden: Set<string>) {
  if (typeof window === 'undefined' || !densityKey) return
  try {
    window.localStorage.setItem(
      `spx:tablecols:${densityKey}`,
      JSON.stringify({ v: 1, hidden: Array.from(hidden) })
    )
  } catch {
    // ignore
  }
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
  sorting,
  defaultDensity = 'cozy',
  densityKey,
  bulkActions,
}: DataTableProps<T>) {
  const [localSortKey, setLocalSortKey] = useState<string | null>(null)
  const [localSortDir, setLocalSortDir] = useState<SortDirection>(null)
  const [density, setDensityState] = useState<DataTableDensity>(() =>
    readDensity(densityKey, defaultDensity)
  )
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => {
    const persisted = readHiddenColumns(densityKey)
    if (persisted.size > 0) return persisted
    // Honour `defaultVisible: false` on initial mount
    return new Set(
      columns
        .filter((c) => c.defaultVisible === false)
        .map((c) => c.id || c.header)
    )
  })
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string | number>>(new Set())
  const [, startTransition] = useTransition()
  const columnsMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!columnsOpen) return
    function onClickOutside(e: MouseEvent) {
      if (!columnsMenuRef.current) return
      if (!columnsMenuRef.current.contains(e.target as Node)) setColumnsOpen(false)
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setColumnsOpen(false)
    }
    window.addEventListener('mousedown', onClickOutside)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('mousedown', onClickOutside)
      window.removeEventListener('keydown', onEsc)
    }
  }, [columnsOpen])

  const setDensity = (next: DataTableDensity) => {
    setDensityState(next)
    if (densityKey && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(`spx:density:${densityKey}`, next)
      } catch {
        // ignore storage failures
      }
    }
  }

  const toggleColumn = (id: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeHiddenColumns(densityKey, next)
      return next
    })
  }

  const sortKey = sorting?.sortKey ?? localSortKey
  const sortDir = sorting?.sortDir ?? localSortDir

  const handleSort = (key: string) => {
    let nextSortKey: string | null = key
    let nextSortDir: SortDirection = 'asc'

    if (sortKey === key) {
      if (sortDir === 'asc') {
        nextSortDir = 'desc'
      } else if (sortDir === 'desc') {
        nextSortKey = null
        nextSortDir = null
      }
    }

    if (sorting) {
      startTransition(() => sorting.onSortChange(nextSortKey, nextSortDir))
      return
    }

    startTransition(() => {
      setLocalSortKey(nextSortKey)
      setLocalSortDir(nextSortDir)
    })
  }

  const data = useMemo(() => {
    if (sorting) return rawData
    if (!sortKey || !sortDir) return rawData
    const col = columns.find((c) => c.sortKey === sortKey || c.header === sortKey)
    return [...rawData].sort((a, b) => {
      const aVal = col ? String(col.render(a) ?? '') : String((a as Record<string, unknown>)[sortKey] ?? '')
      const bVal = col ? String(col.render(b) ?? '') : String((b as Record<string, unknown>)[sortKey] ?? '')
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rawData, sortKey, sortDir, columns, sorting])

  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenColumns.has(c.id || c.header)),
    [columns, hiddenColumns]
  )

  // Drop selections that are no longer in the data set (after pagination, filters, etc).
  useEffect(() => {
    if (selectedKeys.size === 0) return
    const visibleKeys = new Set(data.map(keyField))
    let mutated = false
    const next = new Set<string | number>()
    selectedKeys.forEach((k) => {
      if (visibleKeys.has(k)) next.add(k)
      else mutated = true
    })
    if (mutated) setSelectedKeys(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const allSelected =
    bulkActions && data.length > 0 && data.every((item) => selectedKeys.has(keyField(item)))
  const someSelected =
    bulkActions && !allSelected && data.some((item) => selectedKeys.has(keyField(item)))

  const toggleAll = () => {
    if (!bulkActions) return
    if (allSelected) {
      setSelectedKeys(new Set())
    } else {
      setSelectedKeys(new Set(data.map(keyField)))
    }
  }

  const toggleRow = (key: string | number) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const clearSelection = () => setSelectedKeys(new Set())

  const selectedItems = useMemo(
    () => data.filter((item) => selectedKeys.has(keyField(item))),
    [data, selectedKeys, keyField]
  )

  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
        {emptyIcon}
        <p>{emptyMessage}</p>
      </div>
    )
  }

  const { page, pageSize, totalItems, totalPages, onPageChange, onPageSizeChange } =
    pagination || {}
  const DensityIcon = DENSITY_ICON[density]

  return (
    <div className={cn('space-y-3', className)}>
      {/* Toolbar */}
      <div className="hidden items-center gap-2 md:flex">
        {bulkActions && selectedKeys.size > 0 ? (
          <div className="flex flex-1 flex-wrap items-center gap-2 rounded-xl border border-primary/22 bg-primary/10 px-3 py-1.5 text-sm">
            <span className="font-semibold text-primary font-data">
              {selectedKeys.size} เลือก
            </span>
            <span className="text-muted-foreground">•</span>
            {bulkActions.map((action, i) => {
              const disabled = action.disabled ? action.disabled(selectedItems) : false
              return (
                <Button
                  key={i}
                  size="sm"
                  variant={action.variant || 'outline'}
                  className="h-7 px-2.5 text-xs"
                  disabled={disabled}
                  onClick={() => action.onClick(selectedItems, clearSelection)}
                >
                  {action.icon}
                  {action.label}
                </Button>
              )
            })}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-xs text-muted-foreground"
              onClick={clearSelection}
            >
              ล้าง
            </Button>
          </div>
        ) : (
          <span className="flex-1" aria-hidden="true" />
        )}

        {densityKey ? (
          <div ref={columnsMenuRef} className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setColumnsOpen((v) => !v)}
              title="คอลัมน์ที่แสดง"
              aria-haspopup="menu"
              aria-expanded={columnsOpen}
            >
              <Eye className="h-3.5 w-3.5" />
              <span>คอลัมน์</span>
            </Button>
            {columnsOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-full z-30 mt-2 w-56 rounded-xl border border-white/[0.08] bg-popover p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
              >
                <div className="mb-1 px-2 pt-1 text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground/60">
                  คอลัมน์ที่แสดง
                </div>
                {columns.map((col) => {
                  const id = col.id || col.header
                  const visible = !hiddenColumns.has(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={visible}
                      onClick={() => !col.required && toggleColumn(id)}
                      disabled={col.required}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        col.required
                          ? 'cursor-not-allowed text-muted-foreground/50'
                          : 'text-foreground hover:bg-white/[0.05]'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 items-center justify-center rounded border',
                          visible
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-white/15 bg-white/5'
                        )}
                        aria-hidden="true"
                      >
                        {visible ? <Eye className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5 opacity-0" />}
                      </span>
                      <span className="flex-1 truncate">{col.header}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setDensity(DENSITY_NEXT[density])}
          title={`ปรับความหนาแน่น: ${DENSITY_LABEL[density]}`}
        >
          <DensityIcon className="h-3.5 w-3.5" />
          <span>{DENSITY_LABEL[density]}</span>
        </Button>
      </div>

      {/* Always render the table — on small viewports the user swipes inside
          `.data-scroll` (overflow-x: auto). The page itself stays locked via
          `html, body { overflow-x: clip }` declared in index.css.

          `renderMobile` is accepted for backwards compatibility but is no
          longer used; cards-on-mobile broke alignment with the desktop
          experience and made columns invisible on phones. */}
      <div className="data-scroll">
        <table className="data-table" data-density={density} style={{ minWidth }}>
          <thead>
            <tr>
              {bulkActions ? (
                <th className="w-[2.5rem]">
                  <input
                    type="checkbox"
                    aria-label="เลือกทั้งหมด"
                    checked={!!allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !!someSelected
                    }}
                    onChange={toggleAll}
                    className="h-4 w-4 rounded border-white/15 bg-white/10 text-primary focus:ring-primary focus:ring-offset-background"
                  />
                </th>
              ) : null}
              {visibleColumns.map((col) => {
                const columnSortKey = col.sortKey || col.header
                const isSorted = sortKey === columnSortKey
                const isSortable =
                  col.sortable !== false &&
                  (sorting ? Boolean(col.sortKey) : Boolean(col.sortKey || col.header))
                return (
                  <th
                    key={col.id || col.header}
                    aria-sort={
                      isSorted
                        ? sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : isSortable
                          ? 'none'
                          : undefined
                    }
                    className={cn(
                      col.className,
                      isSortable && 'cursor-pointer select-none transition-colors hover:text-foreground'
                    )}
                    onClick={isSortable ? () => handleSort(columnSortKey) : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.header}
                      {isSortable ? (
                        <span className="inline-flex flex-col -space-y-1">
                          <ArrowUp
                            className={cn(
                              'h-2.5 w-2.5',
                              isSorted && sortDir === 'asc' ? 'text-primary' : 'text-muted-foreground/30'
                            )}
                          />
                          <ArrowDown
                            className={cn(
                              'h-2.5 w-2.5',
                              isSorted && sortDir === 'desc' ? 'text-primary' : 'text-muted-foreground/30'
                            )}
                          />
                        </span>
                      ) : null}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {data.map((item) => {
              const itemKey = keyField(item)
              const checked = selectedKeys.has(itemKey)
              return (
                <tr key={itemKey} data-selected={checked || undefined} className={cn(checked && 'bg-primary/[0.06]')}>
                  {bulkActions ? (
                    <td>
                      <input
                        type="checkbox"
                        aria-label="เลือกแถวนี้"
                        checked={checked}
                        onChange={() => toggleRow(itemKey)}
                        className="h-4 w-4 rounded border-white/15 bg-white/10 text-primary focus:ring-primary focus:ring-offset-background"
                      />
                    </td>
                  ) : null}
                  {visibleColumns.map((col) => (
                    <td key={col.id || col.header} className={col.className}>
                      {col.render(item)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pagination &&
        page !== undefined &&
        pageSize !== undefined &&
        totalItems !== undefined &&
        totalPages !== undefined &&
        onPageChange &&
        onPageSizeChange ? (
        <div className="flex flex-col items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:flex-row">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>แสดง</span>
            <select
              className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} className="bg-popover text-foreground" value={size}>
                  {size}
                </option>
              ))}
            </select>
            <span>รายการต่อหน้า</span>
          </div>

          <div className="flex flex-col items-center gap-4 text-sm text-muted-foreground sm:flex-row">
            <span className="font-data">
              {totalItems > 0
                ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, totalItems)} จาก ${totalItems.toLocaleString()} รายการ`
                : '0 รายการ'}
            </span>
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
      ) : null}
    </div>
  )
}
