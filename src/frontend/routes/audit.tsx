import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { auditApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { formatDateTime } from '../lib/utils'
import { Search } from 'lucide-react'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: AuditComponent,
})

function AuditComponent() {
  const [search, setSearch] = useState('')
  const [username, setUsername] = useState('')
  const [action, setAction] = useState('')

  const { data: logs = [] } = useQuery({
    queryKey: ['audit', { search, username, action }],
    queryFn: () =>
      auditApi.list({
        search: search || undefined,
        username: username || undefined,
        action: action || undefined,
        limit: 200,
      }),
  })

  const handleReset = () => {
    setSearch('')
    setUsername('')
    setAction('')
  }

  return (
    <div className="space-y-6">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white">ประวัติการใช้งาน</CardTitle>
          <p className="text-sm text-muted-foreground">
            ค้นหาและกรองกิจกรรมผู้ใช้
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
              placeholder="ผู้ใช้"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full sm:w-40 bg-white/5 border-white/10"
            />
            <Input
              placeholder="แอคชัน"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="w-full sm:w-40 bg-white/5 border-white/10"
            />
            <Button variant="outline" onClick={handleReset}>
              ล้าง
            </Button>
          </div>

          {/* Table */}
          {logs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ไม่พบประวัติการใช้งาน</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10 text-left text-sm text-muted-foreground">
                    <th className="pb-3 font-medium">ID</th>
                    <th className="pb-3 font-medium">ผู้ทำรายการ</th>
                    <th className="pb-3 font-medium">แอคชัน</th>
                    <th className="pb-3 font-medium hidden md:table-cell">รายละเอียด</th>
                    <th className="pb-3 font-medium">เวลา</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="py-3 text-muted-foreground">{log.id}</td>
                      <td className="py-3">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border border-cyan-400/20 bg-cyan-400/10 text-cyan-400">
                          {log.username}
                        </span>
                      </td>
                      <td className="py-3 text-muted-foreground">{log.action}</td>
                      <td className="py-3 text-muted-foreground hidden md:table-cell max-w-md truncate">
                        {log.details || '—'}
                      </td>
                      <td className="py-3 text-muted-foreground">{formatDateTime(log.createdAt)}</td>
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
