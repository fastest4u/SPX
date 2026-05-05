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
import { Hand, Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, SlidersHorizontal, X, MapPin, Car, Hash } from 'lucide-react'
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
    header: '\u0E15\u0E49\u0E19\u0E17\u0E32\u0E07',
    render: (item) => item.origin,
  },
  {
    header: '\u0E1B\u0E25\u0E32\u0E22\u0E17\u0E32\u0E07',
    render: (item) => item.destination,
  },
  {
    header: '\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E23\u0E16',
    className: 'hidden lg:table-cell',
    render: (item) => item.vehicleType,
  },
  {
    header: '\u0E40\u0E27\u0E25\u0E32\u0E2A\u0E41\u0E15\u0E19\u0E1A\u0E32\u0E22',
    render: (item) => formatDateTime(item.standbyDateTime),
  },
  {
    header: '\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E40\u0E21\u0E37\u0E48\u0E2D',
    render: (item) => formatDateTime(item.createdAt),
  },
  {
    header: '\u0E23\u0E31\u0E1A\u0E07\u0E32\u0E19',
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

  const getPageNumbers = () => {
    const pages = []
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

  return (
    <div className="space-y-5 sm:space-y-6">
      <Card className="glass border-white/10">
        <CardHeader className="gap-4 pb-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-white">{'\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E07\u0E32\u0E19\u0E43\u0E19 DB'}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {total > 0 ? `\u0E1E\u0E1A ${total} \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23` : '\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E07\u0E32\u0E19\u0E22\u0E49\u0E2D\u0E19\u0E2B\u0E25\u0E31\u0E07'}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {/* Summary Stats */}
          {history.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60 text-cyan-300">{'\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14'}</div>
                <div className="flex items-center gap-1.5 text-lg font-black tracking-tight text-cyan-200">
                  <Hash className="h-4 w-4" />
                  {total}
                </div>
              </div>
              <div className="rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60 text-emerald-300">{'\u0E15\u0E49\u0E19\u0E17\u0E32\u0E07'}</div>
                <div className="flex items-center gap-1.5 text-lg font-black tracking-tight text-emerald-200">
                  <MapPin className="h-4 w-4" />
                  {uniqueOrigins.length}
                </div>
              </div>
              <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60 text-amber-300">{'\u0E1B\u0E25\u0E32\u0E22\u0E17\u0E32\u0E07'}</div>
                <div className="flex items-center gap-1.5 text-lg font-black tracking-tight text-amber-200">
                  <MapPin className="h-4 w-4" />
                  {uniqueDests.length}
                </div>
              </div>
              <div className="rounded-xl border border-violet-300/20 bg-violet-300/10 px-3 py-2">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60 text-violet-300">{'\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E23\u0E16'}</div>
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
                placeholder={'\u0E04\u0E49\u0E19\u0E2B\u0E32 Request ID, Booking ID, \u0E40\u0E2A\u0E49\u0E19\u0E17\u0E32\u0E07, \u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E23\u0E16...'}
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
                  <label htmlFor="hist-origin" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E15\u0E49\u0E19\u0E17\u0E32\u0E07'}</label>
                  <Input
                    id="hist-origin"
                    placeholder={'\u0E40\u0E0A\u0E48\u0E19 NERC'}
                    value={origin}
                    onChange={(e) => { setOrigin(e.target.value); setPage(1) }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="hist-dest" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E1B\u0E25\u0E32\u0E22\u0E17\u0E32\u0E07'}</label>
                  <Input
                    id="hist-dest"
                    placeholder={'\u0E40\u0E0A\u0E48\u0E19 SOCE'}
                    value={destination}
                    onChange={(e) => { setDestination(e.target.value); setPage(1) }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="hist-veh" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E23\u0E16'}</label>
                  <Input
                    id="hist-veh"
                    placeholder={'\u0E40\u0E0A\u0E48\u0E19 6WH'}
                    value={vehicleType}
                    onChange={(e) => { setVehicleType(e.target.value); setPage(1) }}
                  />
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={handleReset}>{'\u0E25\u0E49\u0E32\u0E07\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14'}</Button>
              </div>
            </div>
          )}

          {/* Active Filter Chips */}
          {hasFilters && !showFilters && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {origin && (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs text-cyan-200">
                  {'\u0E15\u0E49\u0E19\u0E17\u0E32\u0E07'}: {origin}
                  <button onClick={() => { setOrigin(''); setPage(1) }} className="ml-1 hover:text-white"><X className="h-3 w-3" /></button>
                </span>
              )}
              {destination && (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs text-cyan-200">
                  {'\u0E1B\u0E25\u0E32\u0E22\u0E17\u0E32\u0E07'}: {destination}
                  <button onClick={() => { setDestination(''); setPage(1) }} className="ml-1 hover:text-white"><X className="h-3 w-3" /></button>
                </span>
              )}
              {vehicleType && (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs text-cyan-200">
                  {'\u0E23\u0E16'}: {vehicleType}
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
            emptyMessage={'\u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E07\u0E32\u0E19'}
            renderMobile={(item) => (
              <HistoryMobileCardContent item={item} />
            )}
          />

          {/* Pagination */}
          {history.length > 0 && (
            <div className="mt-4 flex flex-col items-center justify-between gap-4 sm:flex-row bg-white/[0.03] p-3 rounded-xl border border-white/10">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{'\u0E41\u0E2A\u0E14\u0E07'}</span>
                <select
                  className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm text-slate-200 outline-none focus:border-cyan-400"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value))
                    setPage(1)
                  }}
                >
                  <option className="bg-slate-900 text-slate-200" value={10}>10</option>
                  <option className="bg-slate-900 text-slate-200" value={25}>25</option>
                  <option className="bg-slate-900 text-slate-200" value={50}>50</option>
                  <option className="bg-slate-900 text-slate-200" value={100}>100</option>
                </select>
                <span>{'\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E15\u0E48\u0E2D\u0E2B\u0E19\u0E49\u0E32'}</span>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-4 text-sm text-muted-foreground">
                <span>
                  {total > 0 ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} \u0E08\u0E32\u0E01 ${total} \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23` : '0 \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23'}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-md bg-transparent border-white/10"
                    onClick={() => setPage(1)}
                    disabled={page === 1}
                  >
                    <ChevronsLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-md bg-transparent border-white/10"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>

                  {getPageNumbers().map((p) => (
                    <Button
                      key={p}
                      variant={page === p ? "default" : "outline"}
                      className={`h-8 w-8 rounded-md p-0 ${
                        page === p
                          ? 'bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 border-transparent font-bold'
                          : 'bg-transparent border-white/10 text-muted-foreground hover:text-white'
                      }`}
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </Button>
                  ))}

                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-md bg-transparent border-white/10"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages || totalPages === 0}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 rounded-md bg-transparent border-white/10"
                    onClick={() => setPage(totalPages)}
                    disabled={page === totalPages || totalPages === 0}
                  >
                    <ChevronsRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
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
      {'\u0E23\u0E31\u0E1A\u0E07\u0E32\u0E19'}
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
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E15\u0E49\u0E19\u0E17\u0E32\u0E07'}</div>
            <div className="mt-1 text-slate-200">{item.origin || '\u2014'}</div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E1B\u0E25\u0E32\u0E22\u0E17\u0E32\u0E07'}</div>
            <div className="mt-1 text-slate-200">{item.destination || '\u2014'}</div>
          </div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E23\u0E16'}</div>
          <div className="mt-1 text-slate-200">{item.vehicleType || '\u2014'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E40\u0E27\u0E25\u0E32\u0E2A\u0E41\u0E15\u0E19\u0E1A\u0E32\u0E22'}</div>
          <div className="mt-1 text-slate-200">{formatDateTime(item.standbyDateTime) || '\u2014'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E40\u0E21\u0E37\u0E48\u0E2D'}</div>
          <div className="mt-1 text-slate-200">{formatDateTime(item.createdAt)}</div>
        </div>
      </div>
      <div className="mt-4 border-t border-white/10 pt-4">
        <AcceptButton item={item} />
      </div>
    </>
  )
}
