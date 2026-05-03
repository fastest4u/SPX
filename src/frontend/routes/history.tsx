import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { historyApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { formatDateTime } from '../lib/utils'
import { Hand, Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import type { BookingHistory } from '../types'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: HistoryComponent,
})

function HistoryComponent() {
  const [search, setSearch] = useState('')
  const [requestId, setRequestId] = useState('')
  const [bookingId, setBookingId] = useState('')
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [vehicleType, setVehicleType] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const { data: result } = useQuery({
    queryKey: ['history', { search, requestId, bookingId, origin, destination, vehicleType, page, pageSize }],
    queryFn: () =>
      historyApi.paginated({
        search: search || undefined,
        requestId: requestId ? Number(requestId) : undefined,
        bookingId: bookingId ? Number(bookingId) : undefined,
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

  const handleReset = () => {
    setSearch('')
    setRequestId('')
    setBookingId('')
    setOrigin('')
    setDestination('')
    setVehicleType('')
    setPage(1)
  }

  // Calculate page numbers to show
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
        <CardHeader>
          <CardTitle className="text-white">ประวัติงานใน DB</CardTitle>
          <p className="text-sm text-muted-foreground">
            ค้นหา / filter / sort รายการย้อนหลัง และรับงานแบบยืนยันด้วยมือ
          </p>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_auto]">
              <div className="space-y-2">
                <label htmlFor="history-search" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ค้นหา</label>
                <Input
                  id="history-search"
                  placeholder="Request, booking, agency"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setPage(1)
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="history-request-id" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Request ID</label>
                <Input
                  id="history-request-id"
                  type="number"
                  placeholder="Request ID"
                  value={requestId}
                  onChange={(e) => {
                    setRequestId(e.target.value)
                    setPage(1)
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="history-booking-id" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Booking ID</label>
                <Input
                  id="history-booking-id"
                  type="number"
                  placeholder="Booking ID"
                  value={bookingId}
                  onChange={(e) => {
                    setBookingId(e.target.value)
                    setPage(1)
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="history-origin" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ต้นทาง</label>
                <Input
                  id="history-origin"
                  placeholder="ต้นทาง"
                  value={origin}
                  onChange={(e) => {
                    setOrigin(e.target.value)
                    setPage(1)
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="history-destination" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ปลายทาง</label>
                <Input
                  id="history-destination"
                  placeholder="ปลายทาง"
                  value={destination}
                  onChange={(e) => {
                    setDestination(e.target.value)
                    setPage(1)
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="history-vehicle-type" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ประเภทรถ</label>
                <Input
                  id="history-vehicle-type"
                  placeholder="ประเภทรถ"
                  value={vehicleType}
                  onChange={(e) => {
                    setVehicleType(e.target.value)
                    setPage(1)
                  }}
                />
              </div>
              <div className="flex items-end">
                <Button className="w-full lg:w-auto" variant="outline" onClick={handleReset}>
                  ล้าง
                </Button>
              </div>
            </div>
          </div>

          {/* Table */}
          {history.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ไม่พบประวัติงาน</p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:hidden">
                {history.map((item) => (
                  <HistoryMobileCard key={item.id} item={item} />
                ))}
              </div>
              <div className="data-scroll hidden md:block">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Request ID</th>
                      <th>Booking ID</th>
                      <th>ต้นทาง</th>
                      <th>ปลายทาง</th>
                      <th className="hidden lg:table-cell">ประเภทรถ</th>
                      <th>เวลาสแตนบาย</th>
                      <th>บันทึกเมื่อ</th>
                      <th>รับงาน</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item) => (
                      <tr key={item.id}>
                        <td className="text-muted-foreground">{item.requestId}</td>
                        <td className="text-muted-foreground">{item.bookingId}</td>
                        <td className="text-muted-foreground">{item.origin}</td>
                        <td className="text-muted-foreground">{item.destination}</td>
                        <td className="hidden text-muted-foreground lg:table-cell">{item.vehicleType}</td>
                        <td className="text-muted-foreground">{formatDateTime(item.standbyDateTime)}</td>
                        <td className="text-muted-foreground">{formatDateTime(item.createdAt)}</td>
                        <td>
                          <AcceptButton item={item} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              
              {/* Pagination Controls */}
              <div className="mt-4 flex flex-col items-center justify-between gap-4 sm:flex-row bg-white/[0.03] p-3 rounded-xl border border-white/10">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>แสดง</span>
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
                  <span>รายการต่อหน้า</span>
                </div>
                
                <div className="flex flex-col sm:flex-row items-center gap-4 text-sm text-muted-foreground">
                  <span>
                    {total > 0 ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} จาก ${total} รายการ` : '0 รายการ'}
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
                            ? 'bg-linear-to-r from-emerald-400 to-cyan-400 text-slate-950 border-transparent font-bold' 
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
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AcceptButton({ item }: { item: BookingHistory }) {
  if (!item.bookingId) {
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <Button size="sm" variant="outline" className="border-emerald-400/20 text-emerald-300 hover:bg-emerald-400/10">
      <Hand className="h-3 w-3 mr-1" />
      รับงาน
    </Button>
  )
}

function HistoryMobileCard({ item }: { item: BookingHistory }) {
  return (
    <div className="mobile-record">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Request</div>
          <div className="mt-1 text-base font-black text-white">{item.requestId}</div>
        </div>
        <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-right text-cyan-200">
          <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em]">Booking</div>
          <div className="text-sm font-black">{item.bookingId || '—'}</div>
        </div>
      </div>
      <div className="grid gap-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ต้นทาง</div>
            <div className="mt-1 text-slate-200">{item.origin || '—'}</div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ปลายทาง</div>
            <div className="mt-1 text-slate-200">{item.destination || '—'}</div>
          </div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ประเภทรถ</div>
          <div className="mt-1 text-slate-200">{item.vehicleType || '—'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">เวลาสแตนบาย</div>
          <div className="mt-1 text-slate-200">{formatDateTime(item.standbyDateTime) || '—'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">บันทึกเมื่อ</div>
          <div className="mt-1 text-slate-200">{formatDateTime(item.createdAt)}</div>
        </div>
      </div>
      <div className="mt-4 border-t border-white/10 pt-4">
        <AcceptButton item={item} />
      </div>
    </div>
  )
}
