import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { historyApi } from '../lib/api'

import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { ContentSection, FilterPanel, PageShell } from '../components/layout/Page'
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
import {
  ALL_HISTORY_FILTER_VALUE,
  buildHistoryTeamOptions,
  buildHistoryVehicleOptions,
  historyTeamIdFromFilter,
  historyVehicleTypeFromFilter,
  type HistorySelectOption,
} from '../lib/history-filters'
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
  team: string
  origin: string
  destination: string
  vehicleType: string
  pageSize: number
  sortKey: NonNullable<HistoryFilterQuery['sortBy']>
  sortDir: NonNullable<HistoryFilterQuery['sortDir']>
}

const HISTORY_DEFAULT_VIEW: HistoryView = {
  team: ALL_HISTORY_FILTER_VALUE,
  origin: '',
  destination: '',
  vehicleType: ALL_HISTORY_FILTER_VALUE,
  pageSize: 25,
  sortKey: 'created_at',
  sortDir: 'desc',
}

const filterSelectClassName = 'h-10 w-full rounded-[8px] border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-foreground outline-none transition-colors hover:border-white/15 focus:border-ring focus:ring-2 focus:ring-ring/25'

function HistoryComponent() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [searchInput, setSearchInput] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(1)
  const [view, setView, resetView] = useSavedView<HistoryView>('history', HISTORY_DEFAULT_VIEW)
  const normalizedView = { ...HISTORY_DEFAULT_VIEW, ...view }
  const {
    team: rawTeam,
    origin,
    destination,
    vehicleType: rawVehicleType,
    pageSize,
    sortKey,
    sortDir,
  } = normalizedView
  const team = rawTeam || ALL_HISTORY_FILTER_VALUE
  const vehicleType = rawVehicleType || ALL_HISTORY_FILTER_VALUE
  const updateView = (patch: Partial<HistoryView>) => setView((prev) => ({ ...prev, ...patch }))
  const selectedTeamId = isAdmin ? historyTeamIdFromFilter(team) : undefined
  const selectedVehicleType = historyVehicleTypeFromFilter(vehicleType)
  const historyScopeKey = isAdmin
    ? `admin:${selectedTeamId ?? 'all'}`
    : `team:${user?.teamId ?? 'none'}`

  const search = useDebouncedValue(searchInput.trim(), 400)
  const debouncedOrigin = useDebouncedValue(origin.trim(), 300)
  const debouncedDestination = useDebouncedValue(destination.trim(), 300)
  const debouncedVehicleType = useDebouncedValue(selectedVehicleType ?? '', 300)

  const { data: filterOptions } = useQuery({
    queryKey: ['history-filter-options', { scope: historyScopeKey }],
    queryFn: () => historyApi.filterOptions({ teamId: selectedTeamId }),
    staleTime: 5 * 60 * 1000,
  })

  const { data: result, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['history', { scope: historyScopeKey, search, origin: debouncedOrigin, destination: debouncedDestination, vehicleType: debouncedVehicleType, sortKey, sortDir, page, pageSize }],
    queryFn: () =>
      historyApi.paginated({
        search: search || undefined,
        teamId: selectedTeamId,
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
  const teamOptions = buildHistoryTeamOptions(filterOptions?.teams ?? [])
  const vehicleOptions = buildHistoryVehicleOptions(filterOptions?.vehicleTypes ?? uniqueVehicles)
  const selectedTeamLabel = teamOptions.find((option) => option.value === team)?.label

  const hasTeamFilter = isAdmin && team !== ALL_HISTORY_FILTER_VALUE
  const hasFilters = Boolean(origin || destination || selectedVehicleType || hasTeamFilter)

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
                <FilterPanel className="mb-4 space-y-3 animate-in">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-primary/15 bg-primary/10 text-primary">
                        <SlidersHorizontal className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-foreground">Filter panel</div>
                        <div className="text-xs text-muted-foreground">
                          เลือกทีม เส้นทาง และประเภทรถ
                        </div>
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" className="self-start text-xs text-muted-foreground sm:self-auto" onClick={handleReset}>{'ล้างทั้งหมด'}</Button>
                  </div>
                  <div className={`grid gap-3 ${isAdmin ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
                    {isAdmin ? (
                      <HistoryFilterSelect
                        id="hist-team"
                        label="ทีม"
                        value={team}
                        options={teamOptions}
                        onChange={(nextTeam) => {
                          updateView({ team: nextTeam, vehicleType: ALL_HISTORY_FILTER_VALUE })
                          setPage(1)
                        }}
                      />
                    ) : null}
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
                    <HistoryFilterSelect
                      id="hist-veh"
                      label="ประเภทรถ"
                      value={vehicleType}
                      options={vehicleOptions}
                      onChange={(nextVehicleType) => {
                        updateView({ vehicleType: nextVehicleType })
                        setPage(1)
                      }}
                    />
                  </div>
                </FilterPanel>
              ) : null}

              {/* Active Filter Chips */}
              {hasFilters && !showFilters ? (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {hasTeamFilter && selectedTeamLabel ? (
                    <FilterChip label="ทีม" value={selectedTeamLabel} onClear={() => { updateView({ team: ALL_HISTORY_FILTER_VALUE, vehicleType: ALL_HISTORY_FILTER_VALUE }); setPage(1) }} />
                  ) : null}
                  {origin ? (
                    <FilterChip label="ต้นทาง" value={origin} onClear={() => { updateView({ origin: '' }); setPage(1) }} />
                  ) : null}
                  {destination ? (
                    <FilterChip label="ปลายทาง" value={destination} onClear={() => { updateView({ destination: '' }); setPage(1) }} />
                  ) : null}
                  {selectedVehicleType ? (
                    <FilterChip label="รถ" value={selectedVehicleType} onClear={() => { updateView({ vehicleType: ALL_HISTORY_FILTER_VALUE }); setPage(1) }} />
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

function HistoryFilterSelect({
  id,
  label,
  onChange,
  options,
  value,
}: {
  id: string
  label: string
  onChange: (value: string) => void
  options: HistorySelectOption[]
  value: string
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      <select
        id={id}
        className={filterSelectClassName}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
