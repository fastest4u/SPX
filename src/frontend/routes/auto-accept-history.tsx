import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { autoAcceptHistoryApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { formatDateTime } from '../lib/utils'
import { Search, CheckCircle2, XCircle, Truck } from 'lucide-react'
import type { AutoAcceptHistoryItem } from '../types'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auto-accept-history',
  component: AutoAcceptHistoryComponent,
})

const STATUS_OPTIONS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'success', label: 'สำเร็จ' },
  { value: 'failed', label: 'ล้มเหลว' },
]

function AutoAcceptHistoryComponent() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [ruleName, setRuleName] = useState('')

  const { data: items = [] } = useQuery({
    queryKey: ['autoAcceptHistory', { search, status, ruleName }],
    queryFn: () =>
      autoAcceptHistoryApi.list({
        search: search || undefined,
        status: status || undefined,
        ruleName: ruleName || undefined,
        limit: 200,
      }),
  })

  const handleReset = () => {
    setSearch('')
    setStatus('')
    setRuleName('')
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Truck className="h-5 w-5 text-cyan-400" />
            ประวัติการรับงานอัตโนมัติ
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            บันทึกการ auto-accept ทุกครั้ง
          </p>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_auto]">
              <div className="space-y-2">
                <label htmlFor="aah-search" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ค้นหา</label>
                <Input
                  id="aah-search"
                  placeholder="ค้นหาเส้นทาง, ประเภทรถ"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="aah-rule" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Rule</label>
                <Input
                  id="aah-rule"
                  placeholder="ชื่อ Rule"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="aah-status" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">สถานะ</label>
                <select
                  id="aah-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} className="bg-slate-900">
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button className="w-full lg:w-auto" variant="outline" onClick={handleReset}>
                  ล้าง
                </Button>
              </div>
            </div>
          </div>

          {/* Table */}
          {items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ไม่พบประวัติการรับงานอัตโนมัติ</p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:hidden">
                {items.map((item) => (
                  <AutoAcceptMobileCard key={item.id} item={item} />
                ))}
              </div>
              <div className="data-scroll hidden md:block">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Rule</th>
                      <th>เส้นทาง</th>
                      <th>ประเภทรถ</th>
                      <th>งานที่รับ</th>
                      <th>สถานะ</th>
                      <th>เวลา</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td className="text-muted-foreground">{item.id}</td>
                        <td>
                          <span className="status-pill border-violet-300/20 bg-violet-300/10 text-violet-300">
                            {item.ruleName}
                          </span>
                        </td>
                        <td className="text-muted-foreground text-sm">
                          {item.origin} → {item.destination}
                        </td>
                        <td className="text-muted-foreground text-sm">{item.vehicleType || '—'}</td>
                        <td className="text-muted-foreground">
                          {item.requestIds.length} request
                          {item.requestIds.length > 1 ? 's' : ''}
                        </td>
                        <td>
                          {item.status === 'success' ? (
                            <span className="flex items-center gap-1 text-emerald-400">
                              <CheckCircle2 className="h-4 w-4" />
                              สำเร็จ
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-red-400" title={item.errorMessage}>
                              <XCircle className="h-4 w-4" />
                              ล้มเหลว
                            </span>
                          )}
                        </td>
                        <td className="text-muted-foreground text-sm">{formatDateTime(item.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AutoAcceptMobileCard({ item }: { item: AutoAcceptHistoryItem }) {
  const isSuccess = item.status === 'success'
  return (
    <div className="mobile-record">
      <div className="mb-4 flex items-start justify-between gap-3">
        <span className="status-pill border-violet-300/20 bg-violet-300/10 text-violet-300">
          {item.ruleName}
        </span>
        <span className={`flex items-center gap-1 rounded-2xl px-3 py-2 text-xs font-black ${
          isSuccess ? 'bg-emerald-400/10 text-emerald-400 border border-emerald-400/20' : 'bg-red-400/10 text-red-400 border border-red-400/20'
        }`}>
          {isSuccess ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {isSuccess ? 'สำเร็จ' : 'ล้มเหลว'}
        </span>
      </div>
      <div className="grid gap-3 text-sm">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">เส้นทาง</div>
          <div className="mt-1 font-semibold text-white">{item.origin} → {item.destination}</div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">งานที่รับ</div>
            <div className="mt-1 text-slate-200">{item.requestIds.length} requests</div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ประเภทรถ</div>
            <div className="mt-1 text-slate-200">{item.vehicleType || '—'}</div>
          </div>
        </div>
        {item.errorMessage && (
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-red-400">Error</div>
            <div className="mt-1 break-words text-sm text-red-300">{item.errorMessage}</div>
          </div>
        )}
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">เวลา</div>
          <div className="mt-1 text-slate-200">{formatDateTime(item.createdAt)}</div>
        </div>
      </div>
    </div>
  )
}
