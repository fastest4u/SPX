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
import type { AuditLog } from '../types'

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
    <div className="space-y-5 sm:space-y-6">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white">ประวัติการใช้งาน</CardTitle>
          <p className="text-sm text-muted-foreground">
            ค้นหาและกรองกิจกรรมผู้ใช้
          </p>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_auto]">
              <div className="space-y-2">
                <label htmlFor="audit-search" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ค้นหา</label>
                <Input
                  id="audit-search"
                  placeholder="ค้นหารายละเอียด"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="audit-username" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ผู้ใช้</label>
                <Input
                  id="audit-username"
                  placeholder="ผู้ใช้"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="audit-action" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">แอคชัน</label>
                <Input
                  id="audit-action"
                  placeholder="แอคชัน"
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
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
          {logs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ไม่พบประวัติการใช้งาน</p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:hidden">
                {logs.map((log) => (
                  <AuditMobileCard key={log.id} log={log} />
                ))}
              </div>
              <div className="data-scroll hidden md:block">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>ผู้ทำรายการ</th>
                      <th>แอคชัน</th>
                      <th>รายละเอียด</th>
                      <th>เวลา</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id}>
                        <td className="text-muted-foreground">{log.id}</td>
                        <td>
                          <UserBadge username={log.username} />
                        </td>
                        <td className="text-muted-foreground">{log.action}</td>
                        <td className="max-w-md truncate text-muted-foreground">
                          {log.details || '—'}
                        </td>
                        <td className="text-muted-foreground">{formatDateTime(log.createdAt)}</td>
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

function UserBadge({ username }: { username: string }) {
  return (
    <span className="status-pill border-cyan-300/20 bg-cyan-300/10 text-cyan-300">
      {username}
    </span>
  )
}

function AuditMobileCard({ log }: { log: AuditLog }) {
  return (
    <div className="mobile-record">
      <div className="mb-4 flex items-start justify-between gap-3">
        <UserBadge username={log.username} />
        <span className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-black text-slate-200">
          #{log.id}
        </span>
      </div>
      <div className="grid gap-3 text-sm">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">แอคชัน</div>
          <div className="mt-1 font-semibold text-white">{log.action}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">รายละเอียด</div>
          <div className="mt-1 break-words text-slate-200">{log.details || '—'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">เวลา</div>
          <div className="mt-1 text-slate-200">{formatDateTime(log.createdAt)}</div>
        </div>
      </div>
    </div>
  )
}
