import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { CalendarDays, Car, FileImage, ImageIcon, Map, Search, SlidersHorizontal, X } from 'lucide-react'
import { lineImageExtractionApi } from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { PageHeader } from '../components/ui/page-header'
import { SkeletonTable } from '../components/ui/skeleton'
import { formatDateTime } from '../lib/utils'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import type { LineImageExtraction, LineImageExtractionQuery } from '../types'

export const Route = createFileRoute('/line-image-extractions')({
  component: LineImageExtractionsComponent,
})

const COLUMNS: DataTableColumn<LineImageExtraction>[] = [
  {
    header: 'Image',
    sortable: false,
    render: (item) => <ImagePreview item={item} />,
  },
  {
    header: 'Document date',
    sortKey: 'date_text',
    render: (item) => item.dateText || '-',
  },
  {
    header: 'Trip number',
    sortKey: 'trip_number',
    className: 'font-mono text-xs text-warning',
    render: (item) => item.tripNumber || '-',
  },
  {
    header: 'Driver',
    sortKey: 'driver_name',
    className: 'min-w-[240px]',
    render: (item) => item.driverName,
  },
  {
    header: 'Agency',
    render: (item) => (
      <span className="inline-flex rounded-full border border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] px-2 py-1 text-xs font-bold text-success">
        {item.agencyName}
      </span>
    ),
  },
  {
    header: 'Vehicle',
    render: (item) => item.vehicleType,
  },
  {
    header: 'Route',
    sortKey: 'route',
    className: 'min-w-[180px] font-mono text-xs text-info',
    render: (item) => item.route,
  },
  {
    header: 'Saved at',
    sortKey: 'created_at',
    render: (item) => formatDateTime(item.createdAt),
  },
]

function LineImageExtractionsComponent() {
  const [searchInput, setSearchInput] = useState('')
  const [agency, setAgency] = useState('')
  const [tripNumber, setTripNumber] = useState('')
  const [route, setRoute] = useState('')
  const [vehicleType, setVehicleType] = useState('')
  const [driver, setDriver] = useState('')
  const [month, setMonth] = useState('')
  const [createdFrom, setCreatedFrom] = useState('')
  const [createdTo, setCreatedTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [sortKey, setSortKey] = useState<NonNullable<LineImageExtractionQuery['sortBy']>>('created_at')
  const [sortDir, setSortDir] = useState<NonNullable<LineImageExtractionQuery['sortDir']>>('desc')

  const search = useDebouncedValue(searchInput.trim(), 350)
  const debouncedAgency = useDebouncedValue(agency.trim(), 250)
  const debouncedTripNumber = useDebouncedValue(tripNumber.trim(), 250)
  const debouncedRoute = useDebouncedValue(route.trim(), 250)
  const debouncedVehicleType = useDebouncedValue(vehicleType.trim(), 250)
  const debouncedDriver = useDebouncedValue(driver.trim(), 250)

  const query = {
    search: search || undefined,
    agency: debouncedAgency || undefined,
    tripNumber: debouncedTripNumber || undefined,
    route: debouncedRoute || undefined,
    vehicleType: debouncedVehicleType || undefined,
    driver: debouncedDriver || undefined,
    month: month || undefined,
    createdFrom: createdFrom || undefined,
    createdTo: createdTo || undefined,
    sortBy: sortKey,
    sortDir,
    page,
    pageSize,
  } satisfies LineImageExtractionQuery

  const { data: result, isLoading } = useQuery({
    queryKey: ['line-image-extractions', query],
    queryFn: () => lineImageExtractionApi.paginated(query),
    placeholderData: keepPreviousData,
    staleTime: 60 * 1000,
  })

  const rows = result?.data || []
  const total = result?.meta?.total_items || 0
  const totalPages = result?.meta?.total_pages || 0
  const uniqueTripNumbers = new Set(rows.map((row) => row.tripNumber).filter(Boolean)).size
  const uniqueRoutes = new Set(rows.map((row) => row.route).filter(Boolean)).size
  const uniqueVehicles = new Set(rows.map((row) => row.vehicleType).filter(Boolean)).size
  const hasFilters = Boolean(agency || tripNumber || route || vehicleType || driver || month || createdFrom || createdTo)

  const resetFilters = () => {
    setSearchInput('')
    setAgency('')
    setTripNumber('')
    setRoute('')
    setVehicleType('')
    setDriver('')
    setMonth('')
    setCreatedFrom('')
    setCreatedTo('')
    setPage(1)
  }

  if (isLoading) {
    return (
      <Card className="glass border-white/10">
        <SkeletonTable rows={5} cols={5} />
      </Card>
    )
  }

  return (
    <div className="space-y-5 page-enter sm:space-y-6">
      <PageHeader
        icon={FileImage}
        title="LINE Runsheets"
        subtitle={total > 0 ? `${total} saved runsheet records` : 'Saved LH-PWL image extractions will appear here'}
      />

      <Card className="glass border-white/10">
        <CardContent className="p-5 sm:p-6">
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Saved records" value={total} icon={FileImage} tone="info" />
            <Metric label="Trips (page)" value={uniqueTripNumbers} icon={CalendarDays} tone="primary" />
            <Metric label="Routes (page)" value={uniqueRoutes} icon={Map} tone="success" />
            <Metric label="Vehicles (page)" value={uniqueVehicles} icon={Car} tone="warning" />
          </div>

          <div className="mb-4 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(event) => {
                  setSearchInput(event.target.value)
                  setPage(1)
                }}
                placeholder="Search trip number, driver, agency, route, vehicle..."
                className="h-11 pl-10 pr-10"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('')
                    setPage(1)
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={`h-11 w-11 shrink-0 ${showFilters || hasFilters ? 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info' : ''}`}
              onClick={() => setShowFilters((value) => !value)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          {showFilters && (
            <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <FilterInput label="Agency" value={agency} placeholder="LH-PWL" onChange={setAgency} onPageReset={() => setPage(1)} />
                <FilterInput label="Trip number" value={tripNumber} placeholder="LT0Q5L2657AJ2" onChange={setTripNumber} onPageReset={() => setPage(1)} />
                <FilterInput label="Route" value={route} placeholder="NERC > SOCE" onChange={setRoute} onPageReset={() => setPage(1)} />
                <FilterInput label="Vehicle" value={vehicleType} placeholder="6WH" onChange={setVehicleType} onPageReset={() => setPage(1)} />
                <FilterInput label="Driver" value={driver} placeholder="driver name" onChange={setDriver} onPageReset={() => setPage(1)} />
                <div className="space-y-1.5">
                  <label htmlFor="lie-month" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Month</label>
                  <Input id="lie-month" type="month" value={month} onChange={(event) => { setMonth(event.target.value); setPage(1) }} />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="lie-from" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Saved from</label>
                  <Input id="lie-from" type="date" value={createdFrom} onChange={(event) => { setCreatedFrom(event.target.value); setPage(1) }} />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="lie-to" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">Saved to</label>
                  <Input id="lie-to" type="date" value={createdTo} onChange={(event) => { setCreatedTo(event.target.value); setPage(1) }} />
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button type="button" size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={resetFilters}>
                  Clear filters
                </Button>
              </div>
            </div>
          )}

          <DataTable
            columns={COLUMNS}
            data={rows}
            keyField={(item) => item.id}
            densityKey="line-image-extractions"
            minWidth="1160px"
            emptyIcon={<ImageIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />}
            emptyMessage="No saved runsheets found"
            renderMobile={(item) => <MobileRunsheet item={item} />}
            pagination={rows.length > 0 ? {
              page,
              pageSize,
              totalItems: total,
              totalPages,
              onPageChange: setPage,
              onPageSizeChange: (nextPageSize) => {
                setPageSize(nextPageSize)
                setPage(1)
              },
            } : undefined}
            sorting={{
              sortKey,
              sortDir,
              onSortChange: (nextSortKey, nextSortDir) => {
                setSortKey((nextSortKey as LineImageExtractionQuery['sortBy'] | null) ?? 'created_at')
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

function Metric({ label, value, icon: Icon, tone }: { label: string; value: number; icon: typeof FileImage; tone: 'info' | 'success' | 'warning' | 'primary' }) {
  const tones = {
    info: 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info',
    success: 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success',
    warning: 'border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] text-warning',
    primary: 'border-primary/22 bg-primary/10 text-primary',
  }
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${tones[tone]}`}>
      <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-70">{label}</div>
      <div className="mt-1 flex items-center gap-2 text-lg font-black font-data">
        <Icon className="h-4 w-4" />
        {value}
      </div>
    </div>
  )
}

function FilterInput({ label, value, placeholder, onChange, onPageReset }: { label: string; value: string; placeholder: string; onChange: (value: string) => void; onPageReset: () => void }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</label>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value)
          onPageReset()
        }}
      />
    </div>
  )
}

function ImagePreview({ item }: { item: LineImageExtraction }) {
  return (
    <a href={item.imageUrl} target="_blank" rel="noopener noreferrer" className="group inline-flex items-center gap-2">
      <span className="flex h-12 w-12 overflow-hidden rounded-lg border border-white/10 bg-black/20">
        <img src={item.imageUrl} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
      </span>
      <span className="hidden text-xs text-muted-foreground group-hover:text-info lg:inline">Open</span>
    </a>
  )
}

function MobileRunsheet({ item }: { item: LineImageExtraction }) {
  const route = item.route || '—'
  const dateLabel = item.dateText || formatDateTime(item.createdAt).split(' ')[0] || '—'
  return (
    <a
      href={item.imageUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="mobile-row"
      aria-label={`Open runsheet ${item.tripNumber || ''} ${item.driverName || ''}`}
    >
      <span className="mobile-row-leading flex h-12 w-12 overflow-hidden rounded-lg border border-white/10 bg-black/20">
        <img src={item.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
      </span>
      <span className="mobile-row-body">
        <span className="mobile-row-title">
          {item.driverName || '(ไม่ทราบชื่อ)'}
        </span>
        <span className="mobile-row-subtitle">
          <span className="font-data text-warning">{item.tripNumber || '-'}</span>
          <span className="opacity-50"> · </span>
          <span className="font-data text-info">{route}</span>
          <span className="opacity-50"> · </span>
          {item.agencyName || '—'}
          <span className="opacity-50"> · </span>
          {item.vehicleType || '—'}
        </span>
      </span>
      <span className="mobile-row-trailing">
        <span>{dateLabel}</span>
      </span>
    </a>
  )
}
