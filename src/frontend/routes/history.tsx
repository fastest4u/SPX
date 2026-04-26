import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { historyApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { formatDateTime } from '../lib/utils'
import { Hand, Search } from 'lucide-react'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: HistoryComponent,
})

function HistoryComponent() {
  const [search, setSearch] = useState('')
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [vehicleType, setVehicleType] = useState('')

  const { data: history = [] } = useQuery({
    queryKey: ['history', { search, origin, destination, vehicleType }],
    queryFn: () =>
      historyApi.list({
        search: search || undefined,
        origin: origin || undefined,
        destination: destination || undefined,
        vehicleType: vehicleType || undefined,
        limit: 200,
      }),
  })

  const handleReset = () => {
    setSearch('')
    setOrigin('')
    setDestination('')
    setVehicleType('')
  }

  return (
    <div className="space-y-6">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white">ประวัติงานใน DB</CardTitle>
          <p className="text-sm text-muted-foreground">
            ค้นหา / filter / sort รายการย้อนหลัง และรับงานแบบยืนยันด้วยมือ
          </p>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="flex flex-wrap gap-3 mb-6">
            <Input
              placeholder="ค้นหา"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-auto bg-white/5 border-white/10"
            />
            <Input
              placeholder="ต้นทาง"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              className="w-full sm:w-40 bg-white/5 border-white/10"
            />
            <Input
              placeholder="ปลายทาง"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="w-full sm:w-40 bg-white/5 border-white/10"
            />
            <Input
              placeholder="ประเภทรถ"
              value={vehicleType}
              onChange={(e) => setVehicleType(e.target.value)}
              className="w-full sm:w-40 bg-white/5 border-white/10"
            />
            <Button variant="outline" onClick={handleReset}>
              ล้าง
            </Button>
          </div>

          {/* Table */}
          {history.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ไม่พบประวัติงาน</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10 text-left text-sm text-muted-foreground">
                    <th className="pb-3 font-medium">Request ID</th>
                    <th className="pb-3 font-medium">Booking ID</th>
                    <th className="pb-3 font-medium hidden md:table-cell">ต้นทาง</th>
                    <th className="pb-3 font-medium hidden md:table-cell">ปลายทาง</th>
                    <th className="pb-3 font-medium hidden lg:table-cell">ประเภทรถ</th>
                    <th className="pb-3 font-medium">เวลาสแตนบาย</th>
                    <th className="pb-3 font-medium">บันทึกเมื่อ</th>
                    <th className="pb-3 font-medium">รับงาน</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item) => (
                    <tr key={item.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="py-3 text-muted-foreground">{item.requestId}</td>
                      <td className="py-3 text-muted-foreground">{item.bookingId}</td>
                      <td className="py-3 text-muted-foreground hidden md:table-cell">{item.origin}</td>
                      <td className="py-3 text-muted-foreground hidden md:table-cell">{item.destination}</td>
                      <td className="py-3 text-muted-foreground hidden lg:table-cell">{item.vehicleType}</td>
                      <td className="py-3 text-muted-foreground">{item.standbyDateTime}</td>
                      <td className="py-3 text-muted-foreground">{formatDateTime(item.createdAt)}</td>
                      <td className="py-3">
                        {item.bookingId ? (
                          <Button size="sm" variant="outline" className="text-emerald-400 border-emerald-400/20 hover:bg-emerald-400/10">
                            <Hand className="h-3 w-3 mr-1" />
                            รับงาน
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
