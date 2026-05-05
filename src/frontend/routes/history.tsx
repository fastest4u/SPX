import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { historyApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { formatDateTime } from '../lib/utils'
import { Hand, Search, SlidersHorizontal, X, MapPin, Car, Hash } from 'lucide-react'
import type { BookingHistory } from '../types'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: HistoryComponent,
})

const HISTORY_COLUMNS: DataTableColumn<BookingHistory>[] = [
  {
    header: 'Request ID',
    className: 'font-mono text-xs text-cyan-300',
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
    className: 'hidden lg:table-cell',
    render: (item) => item.vehicleType,
  },
  {
    header: 'เวลาสแตนบาย',
    render: (item) => formatDateTime(item.standbyDateTime),
  },
  {
    header: 'บันทึกเมื่อ',
    render: (item) => formatDateTime(item.createdAt),
  },
  {
    header: 'รับงาน',
    render: (item) => <AcceptButton item={item} />,
  },
]

function HistoryComponent() {
  const [search, setSearch] = useState('')
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [vehicleType, setVehicleType] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const { data: result } = useQuery({
    queryKey: ['history', { search, origin, destination, vehicleType, page, pageSize }],
    queryFn: () =>
      historyApi.paginated({
        search: search || undefined,
        origin: origin || undefined,
        destination: destination || undefined,
        vehicleType: vehicleType || undefined,
        page,
        pageSize,
      }),
  })

  const history = result?.data || []
  const total = result?.meta?.total_items || 0
  const totalPages = result?.meta?.total_pages || 0

  const uniqueOrigins = [...new Set(history.map((h) => h.origin).filter(Boolean))]
  const uniqueDests = [...new Set(history.map((h) => h.destination).filter(Boolean))]
  const uniqueVehicles = [...new Set(history.map((h) => h.vehicleType).filter(Boolean))]

  const hasFilters = origin || destination || vehicleType

  const handleReset = () => {
    setSearch('')
    setOrigin('')
    setDestination('')
    setVehicleType('')
    setPage(1)
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <Card className="glass border-white/10">
        <CardHeader className="gap-4 pb-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-white">ประวัติงานใน DB</CardTitle>
            <p className="text-sm text-muted-foreground">
              {total > 0 ? `พบ ${total} รายการ` : 'ค้นหางานย้อนหลัง'}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {/* Summary Stats */}
          {history.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60 text-cyan-300">{'รายการทั้งหมด'}</div>
                <div className="flex items-center gap-1.5 text-lg font-black tracking-tight text-cyan-200">
                  <Hash className="h-4 w-4" />
                  {total}
                </div>
              </div>
              <div className="rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60 text-emerald-300">ต้นทาง</div>
                <div className="flex items-center gap-1.5 text-lg font-black tracking-tight text-emerald-200">
                  <MapPin className="h-4 w-4" />
                  {uniqueOrigins.length}
                </div>
              </div>
              <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60 text-amber-300">ปลายทาง</div>
                <div className="flex items-center gap-1.5 text-lg font-black tracking-tight text-amber-200">
                  <MapPin className="h-4 w-4" />
                  {uniqueDests.length}
                </div>
              </div>
              <div className="rounded-xl border border-violet-300/20 bg-violet-300/10 px-3 py-2">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60 text-violet-300">ประเภทรถ</div>
                <div className="flex items-center gap-1.5 text-lg font-black tracking-tight text-violet-200">
                  <Car className="h-4 w-4" />
                  {uniqueVehicles.length}
                </div>
              </div>
            </div>
          )}

          {/* Search Bar */}
          <div className="mb-4 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={'ค้นหา Request ID, Booking ID, เส้นทาง, ประเภทรถ...'}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(1)
                }}
                className="pl-10 pr-10 h-11 text-base"
              />
              {search && (
                <button
                  onClick={() => { setSearch(''); setPage(1) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button
              variant="outline"
              size="icon"
              className={`h-11 w-11 shrink-0 ${showFilters || hasFilters ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-300' : ''}`}
              onClick={() => setShowFilters(!showFilters)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          {/* Expandable Filters */}
          {showFilters && (
            <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4 animate-in">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label htmlFor="hist-origin" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">ต้นทาง</label>
                  <Input
                    id="hist-origin"
                    placeholder={'เช่น NERC'}
                    value={origin}
                    onChange={(e) => { setOrigin(e.target.value); setPage(1) }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="hist-dest" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">ปลายทาง</label>
                  <Input
                    id="hist-dest"
                    placeholder={'เช่น SOCE'}
                    value={destination}
                    onChange={(e) => { setDestination(e.target.value); setPage(1) }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="hist-veh" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">ประเภทรถ</label>
                  <Input
                    id="hist-veh"
                    placeholder={'เช่น 6WH'}
                    value={vehicleType}
                    onChange={(e) => { setVehicleType(e.target.value); setPage(1) }}
                  />
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={handleReset}>{'ล้างทั้งหมด'}</Button>
              </div>
            </div>
          )}

          {/* Active Filter Chips */}
          {hasFilters && !showFilters && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {origin && (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs text-cyan-200">
                  ต้นทาง: {origin}
                  <button onClick={() => { setOrigin(''); setPage(1) }} className="ml-1 hover:text-white"><X className="h-3 w-3" /></button>
                </span>
              )}
              {destination && (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs text-cyan-200">
                  ปลายทาง: {destination}
                  <button onClick={() => { setDestination(''); setPage(1) }} className="ml-1 hover:text-white"><X className="h-3 w-3" /></button>
                </span>
              )}
              {vehicleType && (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs text-cyan-200">
                  {'รถ'}: {vehicleType}
                  <button onClick={() => { setVehicleType(''); setPage(1) }} className="ml-1 hover:text-white"><X className="h-3 w-3" /></button>
                </span>
              )}
            </div>
          )}

          {/* Data Table */}
          <DataTable
            columns={HISTORY_COLUMNS}
            data={history}
            keyField={(item) => item.id}
            emptyIcon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}
            emptyMessage={'ไม่พบประวัติงาน'}
            renderMobile={(item) => (
              <HistoryMobileCardContent item={item} />
            )}
            pagination={
              history.length > 0
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
          />
        </CardContent>
      </Card>
    </div>
  )
}

function AcceptButton({ item }: { item: BookingHistory }) {
  if (!item.bookingId) {
    return <span className="text-muted-foreground">{'\u2014'}</span>
  }

  return (
    <Button size="sm" variant="outline" className="border-emerald-400/20 text-emerald-300 hover:bg-emerald-400/10">
      <Hand className="h-3 w-3 mr-1" />
      รับงาน
    </Button>
  )
}

function HistoryMobileCardContent({ item }: { item: BookingHistory }) {
  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Request</div>
          <div className="mt-1 text-base font-black text-white">{item.requestId}</div>
        </div>
        <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-right text-cyan-200">
          <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em]">Booking</div>
          <div className="text-sm font-black">{item.bookingId || '\u2014'}</div>
        </div>
      </div>
      <div className="grid gap-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ต้นทาง</div>
            <div className="mt-1 text-slate-200">{item.origin || '\u2014'}</div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ปลายทาง</div>
            <div className="mt-1 text-slate-200">{item.destination || '\u2014'}</div>
          </div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ประเภทรถ</div>
          <div className="mt-1 text-slate-200">{item.vehicleType || '\u2014'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">เวลาสแตนบาย</div>
          <div className="mt-1 text-slate-200">{formatDateTime(item.standbyDateTime) || '\u2014'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">บันทึกเมื่อ</div>
          <div className="mt-1 text-slate-200">{formatDateTime(item.createdAt)}</div>
        </div>
      </div>
      <div className="mt-4 border-t border-white/10 pt-4">
        <AcceptButton item={item} />
      </div>
    </>
  )
}
