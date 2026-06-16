import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { autoAcceptHistoryApi } from '../lib/api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { PaginationControls } from '../components/PaginationControls'
import { ContentSection, EmptyPanel, FilterPanel, MobileRecordCard, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { formatDateTime } from '../lib/utils'
import { SkeletonTable } from '../components/ui/skeleton'
import { Search, CheckCircle2, XCircle, Truck } from 'lucide-react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useAuth } from '../hooks/useAuth'
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
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
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

  const columns = useMemo<DataTableColumn<AutoAcceptHistoryItem>[]>(() => {
    if (!isAdmin) return AAH_COLUMNS
    return [
      {
        header: 'ทีม',
        render: (item) => (
          <span className="status-pill border-white/10 bg-white/[0.04] text-foreground">
            {item.teamName || `Team #${item.teamId}`}
          </span>
        ),
      },
      ...AAH_COLUMNS,
    ]
  }, [isAdmin])

  if (isLoading) {
    return (
      <PageShell>
        <ContentSection>
          <SkeletonTable rows={5} cols={4} />
        </ContentSection>
      </PageShell>
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
    <PageShell>
      <PageHeader
        icon={Truck}
        title="ประวัติการรับงานอัตโนมัติ"
        subtitle="บันทึกการ auto-accept ทุกครั้ง"
      />

      <ContentSection>
          {/* Filters */}
          <FilterPanel>
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
          </FilterPanel>

          <div className="md:hidden">
            {items.length === 0 ? (
              <EmptyPanel icon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}>
                ไม่พบประวัติการรับงานอัตโนมัติ
              </EmptyPanel>
            ) : (
              <div className="space-y-3">
                {items.map((item) => (
                  <AutoAcceptMobileCard key={item.id} item={item} showTeam={isAdmin} />
                ))}
                <PaginationControls
                  variant="mobile"
                  page={page}
                  pageSize={pageSize}
                  totalItems={total}
                  totalPages={totalPages}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => {
                    setPageSize(size)
                    setPage(1)
                  }}
                />
              </div>
            )}
          </div>

          <div className="hidden md:block">
            <DataTable
              columns={columns}
              data={items}
              keyField={(item) => item.id}
              densityKey="auto-accept-history"
              minWidth={isAdmin ? '860px' : '760px'}
              emptyIcon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}
              emptyMessage={'ไม่พบประวัติการรับงานอัตโนมัติ'}
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
          </div>
      </ContentSection>
    </PageShell>
  )
}

function AutoAcceptMobileCard({ item, showTeam }: { item: AutoAcceptHistoryItem; showTeam: boolean }) {
  const isSuccess = item.status === 'success'

  return (
    <MobileRecordCard>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="font-data text-xs text-muted-foreground">#{item.id}</span>
          <div className="mt-1 break-words text-sm font-semibold leading-snug text-primary">
            {item.ruleName}
          </div>
        </div>
        <span className={isSuccess ? 'flex shrink-0 items-center gap-1 text-xs font-semibold text-success' : 'flex shrink-0 items-center gap-1 text-xs font-semibold text-danger'}>
          {isSuccess ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {isSuccess ? 'สำเร็จ' : 'ล้มเหลว'}
        </span>
      </div>

      <div className="mt-3 rounded-[8px] border border-white/[0.06] bg-black/10 p-3">
        <div className="break-words text-sm text-foreground">
          {item.origin} {'\u2192'} {item.destination}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          {showTeam ? (
            <span className="status-pill border-white/10 bg-white/[0.04] text-foreground">
              {item.teamName || `Team #${item.teamId}`}
            </span>
          ) : null}
          <span className="status-pill border-white/10 bg-white/[0.04]">{item.vehicleType || '\u2014'}</span>
          <span className="status-pill border-white/10 bg-white/[0.04]">{item.requestIds.length} requests</span>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>เวลา</span>
        <span className="text-right">{formatDateTime(item.createdAt)}</span>
      </div>

      {!isSuccess && item.errorMessage ? (
        <div className="mt-3 break-words rounded-[8px] border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] p-2 text-xs text-danger">
          {item.errorMessage}
        </div>
      ) : null}
    </MobileRecordCard>
  )
}
