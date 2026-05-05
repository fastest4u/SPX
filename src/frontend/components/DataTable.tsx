import { cn } from '../lib/utils'
import type { ReactNode } from 'react'

export interface DataTableColumn<T> {
  header: string
  className?: string
  render: (item: T) => ReactNode
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
}: DataTableProps<T>) {
  if (data.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
        {emptyIcon}
        <p>{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-0', className)}>
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
    </div>
  )
}
