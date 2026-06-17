import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { historyApi } from '../lib/api'

import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { ContentSection, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { StatCard } from '../components/ui/stat-card'
import { FilterChip } from '../components/ui/filter-chip'
import { Badge } from '../components/ui/badge'
import { ErrorState } from '../components/ui/error-state'
import { formatDateTime } from '../lib/utils'
import { SkeletonTable } from '../components/ui/skeleton'
import { History as HistoryIcon, Search, SlidersHorizontal, X, MapPin, Car, Hash } from 'lucide-react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useSavedView } from '../hooks/useSavedView'
import { useAuth } from '../hooks/useAuth'
import type { BookingHistory, HistoryFilterQuery } from '../types'

export const Route = createFileRoute('/history')({
  component: HistoryComponent,
})

const HISTORY_COLUMNS: DataTableColumn<BookingHistory>[] = [
  {
    header: 'Request ID',
    className: 'font-mono text-xs text-info',
    sortKey: 'request_id',
    render: (item) => item.requestId,
  },
  {
    header: 'Booking ID',
    className: 'font-mono text-xs text-muted-foreground',
    render: (item) => item.bookingId || '\u2014',
  },
  {
    header: 'ต้นทาง',
    render: (item) => item.origin,
  },
  {
    header: 'ปลายทาง',
    render: (item) => item.destination,
  },
  {
    header: 'ประเภทรถ',
    render: (item) => item.vehicleType,
  },
  {
    header: 'เวลาสแตนบาย',
    render: (item) => formatDateTime(item.standbyDateTime),
  },
  {
    header: 'บันทึกเมื่อ',
    sortKey: 'created_at',
    render: (item) => formatDateTime(item.createdAt),
  },
]

interface HistoryView {
  origin: string
  destination: string
  vehicleType: string
  pageSize: number
  sortKey: NonNullable<HistoryFilterQuery['sortBy']>
  sortDir: NonNullable<HistoryFilterQuery['sortDir']>
}

const HISTORY_DEFAULT_VIEW: HistoryView = {
  origin: '',
  destination: '',
  vehicleType: '',
  pageSize: 25,
  sortKey: 'created_at',
  sortDir: 'desc',
}

function HistoryComponent() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [searchInput, setSearchInput] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(1)
  const [view, setView, resetView] = useSavedView<HistoryView>('history', HISTORY_DEFAULT_VIEW)
  const { origin, destination, vehicleType, pageSize, sortKey, sortDir } = view
  const updateView = (patch: Partial<HistoryView>) => setView((prev) => ({ ...prev, ...patch }))

  const search = useDebouncedValue(searchInput.trim(), 400)
  const debouncedOrigin = useDebouncedValue(origin.trim(), 300)
  const debouncedDestination = useDebouncedValue(destination.trim(), 300)
  const debouncedVehicleType = useDebouncedValue(vehicleType.trim(), 300)

  const { data: result, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['history', { search, origin: debouncedOrigin, destination: debouncedDestination, vehicleType: debouncedVehicleType, sortKey, sortDir, page, pageSize }],
    queryFn: () =>
      historyApi.paginated({
        search: search || undefined,
        origin: debouncedOrigin || undefined,
        destination: debouncedDestination || undefined,
        vehicleType: debouncedVehicleType || undefined,
        sortBy: sortKey,
        sortDir,
        page,
        pageSize,
      }),
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
  })

  const columns = useMemo<DataTableColumn<BookingHistory>[]>(() => {
    if (!isAdmin) return HISTORY_COLUMNS
    return [
      {
        header: 'ทีม',
        render: (item) => (
          <Badge variant="neutral">
            {item.teamName || (item.teamId ? `Team #${item.teamId}` : 'ไม่ระบุทีม')}
          </Badge>
        ),
      },
      ...HISTORY_COLUMNS,
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

  const history = result?.data || []
  const total = result?.meta?.total_items || 0
  const totalPages = result?.meta?.total_pages || 0

  const uniqueOrigins = [...new Set(history.map((h) => h.origin).filter(Boolean))]
  const uniqueDests = [...new Set(history.map((h) => h.destination).filter(Boolean))]
  const uniqueVehicles = [...new Set(history.map((h) => h.vehicleType).filter(Boolean))]

  const hasFilters = origin || destination || vehicleType

  const handleReset = () => {
    setSearchInput('')
    resetView()
    setPage(1)
  }

  return (
    <PageShell>
      <PageHeader
        icon={HistoryIcon}
        title="ประวัติงาน"
        subtitle={total > 0 ? `พบ ${total.toLocaleString()} รายการ` : 'ค้นหางานย้อนหลังจากฐานข้อมูล'}
        meta={total > 0 ? <Badge variant="info"><Hash className="h-3 w-3" />{total.toLocaleString()}</Badge> : undefined}
      />

      <ContentSection>
          {isError ? (
            <ErrorState
              title="โหลดประวัติงานไม่สำเร็จ"
              description="ลองกดปุ่มด้านล่างเพื่อลองโหลดอีกครั้ง"
              error={error}
              onRetry={() => refetch()}
            />
          ) : (
            <>
              {/* Summary Stats */}
              {history.length > 0 ? (
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatCard tone="info" label="รายการทั้งหมด" icon={Hash} value={total.toLocaleString()} />
                  <StatCard tone="success" label="ต้นทาง" icon={MapPin} value={uniqueOrigins.length} hint="ในหน้านี้" />
                  <StatCard tone="warning" label="ปลายทาง" icon={MapPin} value={uniqueDests.length} hint="ในหน้านี้" />
                  <StatCard tone="primary" label="ประเภทรถ" icon={Car} value={uniqueVehicles.length} hint="ในหน้านี้" />
                </div>
              ) : null}

              {/* Search Bar */}
              <div className="mb-4 flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={'ค้นหา Request ID, Booking ID, เส้นทาง, ประเภทรถ...'}
                    value={searchInput}
                    onChange={(e) => {
                      setSearchInput(e.target.value)
                      setPage(1)
                    }}
                    className="pl-10 pr-10 h-11 text-base"
                  />
                  {searchInput ? (
                    <button
                      onClick={() => { setSearchInput(''); setPage(1) }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className={`h-11 w-11 shrink-0 ${showFilters || hasFilters ? 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info' : ''}`}
                  onClick={() => setShowFilters(!showFilters)}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                </Button>
              </div>

              {/* Expandable Filters */}
              {showFilters ? (
                <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4 animate-in">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <label htmlFor="hist-origin" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">ต้นทาง</label>
                      <Input
                        id="hist-origin"
                        placeholder={'เช่น NERC'}
                        value={origin}
                        onChange={(e) => { updateView({ origin: e.target.value }); setPage(1) }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="hist-dest" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">ปลายทาง</label>
                      <Input
                        id="hist-dest"
                        placeholder={'เช่น SOCE'}
                        value={destination}
                        onChange={(e) => { updateView({ destination: e.target.value }); setPage(1) }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="hist-veh" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">ประเภทรถ</label>
                      <Input
                        id="hist-veh"
                        placeholder={'เช่น 6WH'}
                        value={vehicleType}
                        onChange={(e) => { updateView({ vehicleType: e.target.value }); setPage(1) }}
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={handleReset}>{'ล้างทั้งหมด'}</Button>
                  </div>
                </div>
              ) : null}

              {/* Active Filter Chips */}
              {hasFilters && !showFilters ? (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {origin ? (
                    <FilterChip label="ต้นทาง" value={origin} onClear={() => { updateView({ origin: '' }); setPage(1) }} />
                  ) : null}
                  {destination ? (
                    <FilterChip label="ปลายทาง" value={destination} onClear={() => { updateView({ destination: '' }); setPage(1) }} />
                  ) : null}
                  {vehicleType ? (
                    <FilterChip label="รถ" value={vehicleType} onClear={() => { updateView({ vehicleType: '' }); setPage(1) }} />
                  ) : null}
                </div>
              ) : null}

              {/* Data Table */}
              <DataTable
                columns={columns}
                data={history}
                keyField={(item) => item.id}
                densityKey="history"
                minWidth={isAdmin ? '780px' : '680px'}
                emptyIcon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}
                emptyMessage={'ไม่พบประวัติงาน'}
                pagination={
                  history.length > 0
                    ? {
                      page,
                      pageSize,
                      totalItems: total,
                      totalPages,
                      onPageChange: setPage,
                      onPageSizeChange: (size) => {
                        updateView({ pageSize: size })
                        setPage(1)
                      },
                    }
                    : undefined
                }
                sorting={{
                  sortKey: sortKey ?? null,
                  sortDir,
                  onSortChange: (nextSortKey, nextSortDir) => {
                    updateView({
                      sortKey: (nextSortKey as HistoryFilterQuery['sortBy'] | null) ?? 'created_at',
                      sortDir: nextSortDir ?? 'desc',
                    })
                    setPage(1)
                  },
                }}
              />
            </>
          )}
      </ContentSection>
    </PageShell>
  )
}
