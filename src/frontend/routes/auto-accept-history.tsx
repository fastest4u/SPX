import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { autoAcceptHistoryApi, biddingApi, teamsApi } from '../lib/api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { PaginationControls } from '../components/PaginationControls'
import { ContentSection, EmptyPanel, FilterPanel, MobileRecordCard, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { formatDateTime } from '../lib/utils'
import { SkeletonTable } from '../components/ui/skeleton'
import { Search, CheckCircle2, XCircle, Truck, Send, Loader2 } from 'lucide-react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useAuth } from '../hooks/useAuth'
import { toast } from 'sonner'
import type { AcceptAllBookingResponse, AutoAcceptHistoryItem, AutoAcceptHistoryQuery, Team } from '../types'

export const Route = createFileRoute('/auto-accept-history')({
  component: AutoAcceptHistoryComponent,
})

const STATUS_OPTIONS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'success', label: 'สำเร็จ' },
  { value: 'failed', label: 'ล้มเหลว' },
  { value: 'indeterminate', label: 'รอตรวจสอบ' },
]

type AutoAcceptHistoryDisplayItem = AutoAcceptHistoryItem & {
  rowIndex: number
}

const AAH_COLUMNS: DataTableColumn<AutoAcceptHistoryDisplayItem>[] = [
  {
    header: 'ลำดับ',
    id: 'rowIndex',
    required: true,
    render: (item) => <span className="font-data text-muted-foreground">{item.rowIndex}</span>,
  },
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
      ) : item.status === 'indeterminate' ? (
        <span className="flex items-center gap-1 text-warning" title={item.errorMessage}>
          <XCircle className="h-4 w-4" />
          {'รอตรวจสอบ'}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-danger" title={item.errorMessage}>
          <XCircle className="h-4 w-4" />
          {'ล้มเหลว'}
        </span>
      ),
  },
  {
    header: 'Reason',
    render: (item) => (
      <span className="text-muted-foreground text-xs">
        {item.failureReason || '\u2014'}
      </span>
    ),
  },
  {
    header: 'Verify',
    render: (item) => (
      <span className="text-muted-foreground text-xs">
        {item.verificationStatus || '\u2014'}
      </span>
    ),
  },
  {
    header: 'Trace',
    render: (item) => (
      <span className="font-data text-[0.65rem] text-muted-foreground" title={item.traceId ?? undefined}>
        {item.traceId ? `${item.traceId.slice(0, 18)}...` : '\u2014'}
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
  const [selectedTeamId, setSelectedTeamId] = useState<number | ''>('')
  const [acceptAllBookingId, setAcceptAllBookingId] = useState('')
  const [acceptAllConfirmed, setAcceptAllConfirmed] = useState(false)
  const [acceptAllResult, setAcceptAllResult] = useState<AcceptAllBookingResponse | null>(null)
  const debouncedSearch = useDebouncedValue(search.trim(), 400)
  const debouncedRuleName = useDebouncedValue(ruleName.trim(), 300)

  const { data: teams = [], isLoading: teamsLoading } = useQuery({
    queryKey: ['teams'],
    queryFn: teamsApi.list,
    enabled: isAdmin,
    staleTime: 60_000,
  })

  const acceptAllMutation = useMutation({
    mutationFn: biddingApi.acceptAll,
    onSuccess: (data) => {
      setAcceptAllResult(data)
      toast.success('ส่ง accept_all แล้ว')
    },
    onError: (error: Error) => {
      toast.error('accept_all ไม่สำเร็จ', { description: error.message })
    },
  })

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

  const columns = useMemo<DataTableColumn<AutoAcceptHistoryDisplayItem>[]>(() => {
    if (!isAdmin) return AAH_COLUMNS
    return [
      {
        header: 'ทีม',
        id: 'team',
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
  const displayItems: AutoAcceptHistoryDisplayItem[] = items.map((item, index) => ({
    ...item,
    rowIndex: (page - 1) * pageSize + index + 1,
  }))

  const handleReset = () => {
    setSearch('')
    setStatus('')
    setRuleName('')
    setPage(1)
  }

  const submitAcceptAll = () => {
    const bookingId = Number(acceptAllBookingId.trim())
    if (typeof selectedTeamId !== 'number') {
      toast.error('กรุณาเลือกทีม')
      return
    }
    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      toast.error('Booking ID ไม่ถูกต้อง')
      return
    }
    if (!acceptAllConfirmed) {
      toast.error('กรุณายืนยันก่อนส่ง')
      return
    }
    acceptAllMutation.mutate({ teamId: selectedTeamId, bookingId, confirm: true })
  }

  return (
    <PageShell>
      <PageHeader
        icon={Truck}
        title="ประวัติการรับงานอัตโนมัติ"
        subtitle="บันทึกการ auto-accept ทุกครั้ง"
      />

      <ContentSection>
          {isAdmin ? (
            <AdminAcceptAllPanel
              teams={teams}
              teamsLoading={teamsLoading}
              selectedTeamId={selectedTeamId}
              onTeamChange={setSelectedTeamId}
              bookingId={acceptAllBookingId}
              onBookingIdChange={setAcceptAllBookingId}
              confirmed={acceptAllConfirmed}
              onConfirmedChange={setAcceptAllConfirmed}
              isPending={acceptAllMutation.isPending}
              result={acceptAllResult}
              onSubmit={submitAcceptAll}
            />
          ) : null}

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
            {displayItems.length === 0 ? (
              <EmptyPanel icon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}>
                ไม่พบประวัติการรับงานอัตโนมัติ
              </EmptyPanel>
            ) : (
              <div className="space-y-3">
                {displayItems.map((item) => (
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
              data={displayItems}
              keyField={(item) => item.id}
              densityKey="auto-accept-history"
              minWidth={isAdmin ? '920px' : '820px'}
              emptyIcon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}
              emptyMessage={'ไม่พบประวัติการรับงานอัตโนมัติ'}
              pagination={
                displayItems.length > 0
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

function AdminAcceptAllPanel({
  teams,
  teamsLoading,
  selectedTeamId,
  onTeamChange,
  bookingId,
  onBookingIdChange,
  confirmed,
  onConfirmedChange,
  isPending,
  result,
  onSubmit,
}: {
  teams: Team[]
  teamsLoading: boolean
  selectedTeamId: number | ''
  onTeamChange: (teamId: number | '') => void
  bookingId: string
  onBookingIdChange: (bookingId: string) => void
  confirmed: boolean
  onConfirmedChange: (confirmed: boolean) => void
  isPending: boolean
  result: AcceptAllBookingResponse | null
  onSubmit: () => void
}) {
  const bookingIdNumber = Number(bookingId.trim())
  const canSubmit =
    typeof selectedTeamId === 'number'
    && Number.isInteger(bookingIdNumber)
    && bookingIdNumber > 0
    && confirmed
    && !isPending

  return (
    <FilterPanel>
      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr_auto_auto] lg:items-end">
        <div className="space-y-2">
          <label htmlFor="accept-all-team" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ทีม</label>
          <select
            id="accept-all-team"
            value={selectedTeamId}
            onChange={(event) => onTeamChange(event.target.value ? Number(event.target.value) : '')}
            disabled={teamsLoading || isPending}
            className="flex h-10 w-full rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="" className="bg-popover">เลือกทีม</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id} className="bg-popover">
                {team.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <label htmlFor="accept-all-booking" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Booking ID</label>
          <Input
            id="accept-all-booking"
            inputMode="numeric"
            value={bookingId}
            onChange={(event) => onBookingIdChange(event.target.value)}
            disabled={isPending}
            placeholder="2706815"
          />
        </div>
        <label className="flex min-h-10 items-center gap-2 rounded-[8px] border border-white/10 bg-white/[0.03] px-3 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => onConfirmedChange(event.target.checked)}
            disabled={isPending}
            className="h-4 w-4 accent-primary"
          />
          ยืนยัน
        </label>
        <Button type="button" onClick={onSubmit} disabled={!canSubmit} className="w-full lg:w-auto">
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          accept_all
        </Button>
      </div>
      {result ? (
        <pre className="mt-3 max-h-56 overflow-auto rounded-[8px] border border-white/10 bg-black/10 p-3 text-xs leading-5 text-muted-foreground">
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </FilterPanel>
  )
}

function AutoAcceptMobileCard({ item, showTeam }: { item: AutoAcceptHistoryDisplayItem; showTeam: boolean }) {
  const isSuccess = item.status === 'success'
  const isIndeterminate = item.status === 'indeterminate'

  return (
    <MobileRecordCard>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="status-pill border-white/10 bg-white/[0.04] text-muted-foreground">
              ลำดับ {item.rowIndex}
            </span>
            <span className="font-data text-xs text-muted-foreground">ID #{item.id}</span>
          </div>
          <div className="mt-1 break-words text-sm font-semibold leading-snug text-primary">
            {item.ruleName}
          </div>
        </div>
        <span className={isSuccess ? 'flex shrink-0 items-center gap-1 text-xs font-semibold text-success' : isIndeterminate ? 'flex shrink-0 items-center gap-1 text-xs font-semibold text-warning' : 'flex shrink-0 items-center gap-1 text-xs font-semibold text-danger'}>
          {isSuccess ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {isSuccess ? 'สำเร็จ' : isIndeterminate ? 'รอตรวจสอบ' : 'ล้มเหลว'}
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
          {item.failureReason ? (
            <span className="status-pill border-white/10 bg-white/[0.04]">{item.failureReason}</span>
          ) : null}
          {item.verificationStatus ? (
            <span className="status-pill border-white/10 bg-white/[0.04]">{item.verificationStatus}</span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>เวลา</span>
        <span className="text-right">{formatDateTime(item.createdAt)}</span>
      </div>

      {item.traceId ? (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>Trace</span>
          <span className="font-data text-right">{item.traceId}</span>
        </div>
      ) : null}

      {!isSuccess && item.errorMessage ? (
        <div className="mt-3 break-words rounded-[8px] border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] p-2 text-xs text-danger">
          {item.errorMessage}
        </div>
      ) : null}
    </MobileRecordCard>
  )
}
