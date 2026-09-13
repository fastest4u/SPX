import { useId, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { CalendarDays, Car, FileImage, ImageIcon, Map, Search, SlidersHorizontal, X } from 'lucide-react'
import { lineImageExtractionApi } from '../lib/api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { PaginationControls } from '../components/PaginationControls'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { ContentSection, EmptyPanel, FilterPanel, MobileRecordCard, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { FilterChip } from '../components/ui/filter-chip'
import { SkeletonTable } from '../components/ui/skeleton'
import { ErrorState } from '../components/ui/error-state'
import { formatDateTime, safeBrowserUrl } from '../lib/utils'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import type { LineImageExtraction, LineImageExtractionQuery } from '../types'

export const Route = createFileRoute('/line-image-extractions')({
  component: LineImageExtractionsComponent,
})

const COLUMNS: DataTableColumn<LineImageExtraction>[] = [
  {
    header: 'ภาพ',
    sortable: false,
    render: (item) => <ImagePreview item={item} />,
  },
  {
    header: 'วันที่เอกสาร',
    sortKey: 'date_text',
    render: (item) => item.dateText || '-',
  },
  {
    header: 'เลขเที่ยว',
    sortKey: 'trip_number',
    className: 'font-mono text-xs text-warning',
    render: (item) => item.tripNumber || '-',
  },
  {
    header: 'คนขับ',
    sortKey: 'driver_name',
    className: 'min-w-[240px]',
    render: (item) => item.driverName,
  },
  {
    header: 'บริษัท',
    render: (item) => (
      <span className="inline-flex rounded-full border border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] px-2 py-1 text-xs font-bold text-success">
        {item.agencyName}
      </span>
    ),
  },
  {
    header: 'ประเภทรถ',
    render: (item) => item.vehicleType,
  },
  {
    header: 'เส้นทาง',
    sortKey: 'route',
    className: 'min-w-[180px] font-mono text-xs text-info',
    render: (item) => item.route,
  },
  {
    header: 'บันทึกเมื่อ',
    sortKey: 'created_at',
    render: (item) => formatDateTime(item.createdAt),
  },
]

function LineImageExtractionsComponent() {
  const searchRef = useRef<HTMLInputElement>(null)
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
    search: searchInput.trim() ? search || undefined : undefined,
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

  const { data: result, isLoading, isError, error, refetch } = useQuery({
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
  const hasFilters = Boolean(searchInput || agency || tripNumber || route || vehicleType || driver || month || createdFrom || createdTo)

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
      <PageShell>
        <ContentSection>
        <SkeletonTable rows={5} cols={5} />
        </ContentSection>
      </PageShell>
    )
  }

  return (
    <PageShell>
      <PageHeader
        icon={FileImage}
        title="LINE Runsheets"
        subtitle={isError && !result ? 'ยังยืนยันข้อมูล LINE Runsheets ไม่ได้' : total > 0 ? `${total} ใบงานที่บันทึกไว้` : 'ใบงาน LH-PWL ที่บันทึกแล้วจะแสดงที่นี่'}
      />

      <ContentSection>
          {(!isError || !!result) && <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="ใบงานที่บันทึก" value={total} icon={FileImage} tone="info" />
            <Metric label="เที่ยวในหน้านี้" value={uniqueTripNumbers} icon={CalendarDays} tone="primary" />
            <Metric label="เส้นทางในหน้านี้" value={uniqueRoutes} icon={Map} tone="success" />
            <Metric label="ประเภทรถในหน้านี้" value={uniqueVehicles} icon={Car} tone="warning" />
          </div>}

          <div className="mb-4 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                aria-label="ค้นหา LINE Runsheets"
                value={searchInput}
                onChange={(event) => {
                  setSearchInput(event.target.value)
                  setPage(1)
                }}
                placeholder="ค้นหาเลขเที่ยว คนขับ บริษัท เส้นทาง ประเภทรถ..."
                className="h-11 pl-10 pr-10"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('')
                    setPage(1)
                    searchRef.current?.focus()
                  }}
                  aria-label="ล้างคำค้นหา LINE Runsheets"
                  className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded focus-visible:ring-2 focus-visible:ring-ring text-muted-foreground hover:text-foreground"
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
              aria-label="ตัวกรอง LINE Runsheets"
              aria-expanded={showFilters}
              aria-controls="runsheet-filters"
              onClick={() => setShowFilters((value) => !value)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          {showFilters && (
            <div id="runsheet-filters"><FilterPanel className="mb-4 space-y-3 animate-in">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-primary/15 bg-primary/10 text-primary">
                    <SlidersHorizontal className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-foreground">ตัวกรอง</div>
                    <div className="text-xs text-muted-foreground">
                      กรองตาม Agency, Trip Number, Route, วันที่ และข้อมูลอื่นๆ
                    </div>
                  </div>
                </div>
                <Button type="button" size="sm" variant="ghost" className="self-start text-xs text-muted-foreground sm:self-auto" onClick={resetFilters}>
                  ล้างทั้งหมด
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <FilterInput label="บริษัท" value={agency} placeholder="LH-PWL" onChange={setAgency} onPageReset={() => setPage(1)} />
                <FilterInput label="เลขเที่ยว" value={tripNumber} placeholder="LT0Q5L2657AJ2" onChange={setTripNumber} onPageReset={() => setPage(1)} />
                <FilterInput label="เส้นทาง" value={route} placeholder="NERC > SOCE" onChange={setRoute} onPageReset={() => setPage(1)} />
                <FilterInput label="ประเภทรถ" value={vehicleType} placeholder="6WH" onChange={setVehicleType} onPageReset={() => setPage(1)} />
                <FilterInput label="คนขับ" value={driver} placeholder="driver name" onChange={setDriver} onPageReset={() => setPage(1)} />
                <div className="space-y-1.5">
                  <label htmlFor="lie-month" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">เดือน</label>
                  <Input id="lie-month" type="month" value={month} onChange={(event) => { setMonth(event.target.value); setPage(1) }} />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="lie-from" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">บันทึกตั้งแต่</label>
                  <Input id="lie-from" type="date" value={createdFrom} onChange={(event) => { setCreatedFrom(event.target.value); setPage(1) }} />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="lie-to" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">บันทึกถึง</label>
                  <Input id="lie-to" type="date" value={createdTo} onChange={(event) => { setCreatedTo(event.target.value); setPage(1) }} />
                </div>
              </div>
            </FilterPanel></div>
          )}

          {/* Active Filter Chips */}
          {hasFilters ? (
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              {searchInput ? (
                <FilterChip label="ค้นหา" value={searchInput} onClear={() => { setSearchInput(''); setPage(1) }} />
              ) : null}
              {agency ? (
                <FilterChip label="บริษัท" value={agency} onClear={() => { setAgency(''); setPage(1) }} />
              ) : null}
              {tripNumber ? (
                <FilterChip label="Trip" value={tripNumber} onClear={() => { setTripNumber(''); setPage(1) }} />
              ) : null}
              {route ? (
                <FilterChip label="เส้นทาง" value={route} onClear={() => { setRoute(''); setPage(1) }} />
              ) : null}
              {vehicleType ? (
                <FilterChip label="ประเภทรถ" value={vehicleType} onClear={() => { setVehicleType(''); setPage(1) }} />
              ) : null}
              {driver ? (
                <FilterChip label="คนขับ" value={driver} onClear={() => { setDriver(''); setPage(1) }} />
              ) : null}
              {month ? (
                <FilterChip label="เดือน" value={month} onClear={() => { setMonth(''); setPage(1) }} />
              ) : null}
              {createdFrom ? (
                <FilterChip label="From" value={createdFrom} onClear={() => { setCreatedFrom(''); setPage(1) }} />
              ) : null}
              {createdTo ? (
                <FilterChip label="To" value={createdTo} onClear={() => { setCreatedTo(''); setPage(1) }} />
              ) : null}
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={resetFilters}>
                ล้างทั้งหมด
              </Button>
            </div>
          ) : null}

          {isError ? (
            <ErrorState
              title="โหลด LINE Runsheets ไม่สำเร็จ"
              description={rows.length > 0 ? 'แสดงข้อมูลล่าสุดที่โหลดสำเร็จ ข้อมูลอาจยังไม่เป็นปัจจุบัน ลองโหลดอีกครั้งได้' : undefined}
              error={error}
              onRetry={() => void refetch()}
              className="mb-4"
            />
          ) : null}

          {(!isError || rows.length > 0) && <>
          <div className="space-y-3 md:hidden">
            {rows.length === 0 ? <EmptyPanel>ไม่พบใบงานที่บันทึกไว้</EmptyPanel> : rows.map((item) => (
              <MobileRecordCard key={item.id}>
                <h2 className="break-words font-semibold text-warning">{item.tripNumber || 'ไม่มีเลขเที่ยว'}</h2>
                <p className="mt-2 break-words text-info">{item.route}</p>
                <dl className="my-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                  <dt>คนขับ</dt><dd className="break-words">{item.driverName}</dd>
                  <dt>ประเภทรถ</dt><dd>{item.vehicleType}</dd>
                  <dt>บริษัท</dt><dd className="break-words">{item.agencyName}</dd>
                  <dt>วันที่เอกสาร</dt><dd>{item.dateText || '—'}</dd>
                  <dt>บันทึกเมื่อ</dt><dd className="break-words">{formatDateTime(item.createdAt)}</dd>
                </dl>
                <ImagePreview item={item} />
              </MobileRecordCard>
            ))}
            {rows.length > 0 && <PaginationControls variant="mobile" page={page} pageSize={pageSize} totalItems={total} totalPages={totalPages} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1) }} />}
          </div>
          <div className="hidden md:block"><DataTable
            columns={COLUMNS}
            data={rows}
            keyField={(item) => item.id}
            densityKey="line-image-extractions"
            minWidth="1160px"
            emptyIcon={<ImageIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />}
            emptyMessage="ไม่พบใบงานที่บันทึกไว้"
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
          /></div></>}
      </ContentSection>
    </PageShell>
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
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</label>
      <Input
        id={id}
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
  const imageUrl = safeBrowserUrl(item.imageUrl)
  if (!imageUrl) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black/20">
          <ImageIcon className="h-4 w-4" />
        </span>
        <span className="hidden lg:inline">ไม่มีภาพ</span>
      </span>
    )
  }

  return (
    <a aria-label={`เปิดภาพใบงาน ${item.tripNumber || item.id}`} href={imageUrl} target="_blank" rel="noopener noreferrer" className="group inline-flex items-center gap-2 rounded focus-visible:ring-2 focus-visible:ring-ring">
      <span className="flex h-12 w-12 overflow-hidden rounded-lg border border-white/10 bg-black/20">
        <img src={imageUrl} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
      </span>
      <span className="hidden text-xs text-muted-foreground group-hover:text-info lg:inline">เปิดภาพ</span>
    </a>
  )
}
