import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { autoAcceptHistoryApi } from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { PageHeader } from '../components/ui/page-header'
import { formatDateTime } from '../lib/utils'
import { SkeletonTable } from '../components/ui/skeleton'
import { Search, CheckCircle2, XCircle, Truck } from 'lucide-react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import type { AutoAcceptHistoryItem, AutoAcceptHistoryQuery } from '../types'

export const Route = createFileRoute('/auto-accept-history')({
  component: AutoAcceptHistoryComponent,
})

const STATUS_OPTIONS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'success', label: 'สำเร็จ' },
  { value: 'failed', label: 'ล้มเหลว' },
]

const AAH_COLUMNS: DataTableColumn<AutoAcceptHistoryItem>[] = [
  {
    header: 'ID',
    sortKey: 'id',
    render: (item) => <span className="text-muted-foreground">{item.id}</span>,
  },
  {
    header: 'Rule',
    render: (item) => (
      <span className="status-pill border-primary/22 bg-primary/10 text-primary">
        {item.ruleName}
      </span>
    ),
  },
  {
    header: 'เส้นทาง',
    render: (item) => (
      <span className="text-muted-foreground text-sm">
        {item.origin} {'\u2192'} {item.destination}
      </span>
    ),
  },
  {
    header: 'ประเภทรถ',
    render: (item) => <span className="text-muted-foreground text-sm">{item.vehicleType || '\u2014'}</span>,
  },
  {
    header: 'งานที่รับ',
    render: (item) => (
      <span className="text-muted-foreground">
        {item.requestIds.length} request{item.requestIds.length > 1 ? 's' : ''}
      </span>
    ),
  },
  {
    header: 'สถานะ',
    render: (item) =>
      item.status === 'success' ? (
        <span className="flex items-center gap-1 text-success">
          <CheckCircle2 className="h-4 w-4" />
          {'สำเร็จ'}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-danger" title={item.errorMessage}>
          <XCircle className="h-4 w-4" />
          {'ล้มเหลว'}
        </span>
      ),
  },
  {
    header: 'เวลา',
    sortKey: 'created_at',
    render: (item) => <span className="text-muted-foreground text-sm">{formatDateTime(item.createdAt)}</span>,
  },
]

function AutoAcceptHistoryComponent() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [ruleName, setRuleName] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [sortKey, setSortKey] = useState<NonNullable<AutoAcceptHistoryQuery['sortBy']>>('created_at')
  const [sortDir, setSortDir] = useState<NonNullable<AutoAcceptHistoryQuery['sortDir']>>('desc')
  const debouncedSearch = useDebouncedValue(search.trim(), 400)
  const debouncedRuleName = useDebouncedValue(ruleName.trim(), 300)

  const { data: result, isLoading } = useQuery({
    queryKey: ['autoAcceptHistory', { search: debouncedSearch, status, ruleName: debouncedRuleName, sortKey, sortDir, page, pageSize }],
    queryFn: () =>
      autoAcceptHistoryApi.paginated({
        search: debouncedSearch || undefined,
        status: status || undefined,
        ruleName: debouncedRuleName || undefined,
        sortBy: sortKey,
        sortDir,
        page,
        pageSize,
      }),
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="space-y-5 sm:space-y-6">
        <Card className="glass border-white/10">
          <SkeletonTable rows={5} cols={4} />
        </Card>
      </div>
    )
  }

  const items = result?.data || []
  const total = result?.meta?.total_items || 0
  const totalPages = result?.meta?.total_pages || 0

  const handleReset = () => {
    setSearch('')
    setStatus('')
    setRuleName('')
    setPage(1)
  }

  return (
    <div className="space-y-5 page-enter sm:space-y-6">
      <PageHeader
        icon={Truck}
        title="ประวัติการรับงานอัตโนมัติ"
        subtitle="บันทึกการ auto-accept ทุกครั้ง"
      />

      <Card className="glass border-white/10">
        <CardContent className="p-5 sm:p-6">
          {/* Filters */}
          <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_auto]">
              <div className="space-y-2">
                <label htmlFor="aah-search" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'ค้นหา'}</label>
                <Input
                  id="aah-search"
                  placeholder={'ค้นหาเส้นทาง, ประเภทรถ'}
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="aah-rule" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Rule</label>
                <Input
                  id="aah-rule"
                  placeholder={'ชื่อ Rule'}
                  value={ruleName}
                  onChange={(e) => { setRuleName(e.target.value); setPage(1) }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="aah-status" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'สถานะ'}</label>
                <select
                  id="aah-status"
                  value={status}
                  onChange={(e) => { setStatus(e.target.value); setPage(1) }}
                  className="flex h-10 w-full rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} className="bg-popover">
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button className="w-full lg:w-auto" variant="outline" onClick={handleReset}>
                  {'ล้าง'}
                </Button>
              </div>
            </div>
          </div>

          {/* Data Table */}
          <DataTable
            columns={AAH_COLUMNS}
            data={items}
            keyField={(item) => item.id}
            densityKey="auto-accept-history"
            emptyIcon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}
            emptyMessage={'ไม่พบประวัติการรับงานอัตโนมัติ'}
            renderMobile={(item) => (
              <AutoAcceptMobileCardContent item={item} />
            )}
            pagination={
              items.length > 0
                ? {
                  page,
                  pageSize,
                  totalItems: total,
                  totalPages,
                  onPageChange: setPage,
                  onPageSizeChange: (size) => {
                    setPageSize(size)
                    setPage(1)
                  },
                }
                : undefined
            }
            sorting={{
              sortKey,
              sortDir,
              onSortChange: (nextSortKey, nextSortDir) => {
                setSortKey((nextSortKey as AutoAcceptHistoryQuery['sortBy'] | null) ?? 'created_at')
                setSortDir(nextSortDir ?? 'desc')
                setPage(1)
              },
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function AutoAcceptMobileCardContent({ item }: { item: AutoAcceptHistoryItem }) {
  const isSuccess = item.status === 'success'
  const dateLabel = formatDateTime(item.createdAt).split(' ')[0] || '—'
  const StatusIcon = isSuccess ? CheckCircle2 : XCircle
  const statusTone = isSuccess ? 'text-success' : 'text-danger'
  return (
    <div className={`mobile-row ${isSuccess ? '' : 'border-[color:var(--color-danger-border)]'}`}>
      <span className={`mobile-row-leading mt-0.5 ${statusTone}`}>
        <StatusIcon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="mobile-row-body">
        <span className="mobile-row-title">
          {item.ruleName}
          <span className="opacity-50"> · </span>
          <span className="text-info">{item.requestIds.length} req</span>
        </span>
        <span className="mobile-row-subtitle">
          {item.origin} → {item.destination}
          <span className="opacity-50"> · </span>
          {item.vehicleType || '—'}
        </span>
        {item.errorMessage ? (
          <span className="mobile-row-subtitle text-danger">{item.errorMessage}</span>
        ) : null}
      </span>
      <span className="mobile-row-trailing">
        <span>{dateLabel}</span>
      </span>
    </div>
  )
}
