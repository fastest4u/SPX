import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { auditApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { formatDateTime } from '../lib/utils'
import { Search } from 'lucide-react'
import type { AuditLog } from '../types'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: AuditComponent,
})

function UserBadge({ username }: { username: string }) {
  return (
    <span className="status-pill border-cyan-300/20 bg-cyan-300/10 text-cyan-300">
      {username}
    </span>
  )
}

const AUDIT_COLUMNS: DataTableColumn<AuditLog>[] = [
  {
    header: 'ID',
    render: (log) => <span className="text-muted-foreground">{log.id}</span>,
  },
  {
    header: 'ผู้ทำรายการ',
    render: (log) => <UserBadge username={log.username} />,
  },
  {
    header: 'แอคชัน',
    render: (log) => <span className="text-muted-foreground">{log.action}</span>,
  },
  {
    header: 'รายละเอียด',
    render: (log) => (
      <span className="max-w-md truncate text-muted-foreground block">
        {log.details || '\u2014'}
      </span>
    ),
  },
  {
    header: 'เวลา',
    render: (log) => <span className="text-muted-foreground">{formatDateTime(log.createdAt)}</span>,
  },
]

function AuditComponent() {
  const [search, setSearch] = useState('')
  const [username, setUsername] = useState('')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const { data: result } = useQuery({
    queryKey: ['audit', { search, username, action, page, pageSize }],
    queryFn: () =>
      auditApi.paginated({
        search: search || undefined,
        username: username || undefined,
        action: action || undefined,
        page,
        pageSize,
      }),
  })

  const logs = result?.data || []
  const total = result?.meta?.total_items || 0
  const totalPages = result?.meta?.total_pages || 0

  const handleReset = () => {
    setSearch('')
    setUsername('')
    setAction('')
    setPage(1)
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white">{'ประวัติการใช้งาน'}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {'ค้นหาและกรองกิจกรรมผู้ใช้'}
          </p>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_auto]">
              <div className="space-y-2">
                <label htmlFor="audit-search" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'ค้นหา'}</label>
                <Input
                  id="audit-search"
                  placeholder={'ค้นหารายละเอียด'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="audit-username" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'ผู้ใช้'}</label>
                <Input
                  id="audit-username"
                  placeholder={'ผู้ใช้'}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="audit-action" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'แอคชัน'}</label>
                <Input
                  id="audit-action"
                  placeholder={'แอคชัน'}
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <Button className="w-full lg:w-auto" variant="outline" onClick={handleReset}>
                  {'ล้าง'}
                </Button>
              </div>
            </div>
          </div>

          {/* Data Table */}
          <DataTable
            columns={AUDIT_COLUMNS}
            data={logs}
            keyField={(log) => log.id}
            emptyIcon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}
            emptyMessage={'ไม่พบประวัติการใช้งาน'}
            renderMobile={(log) => (
              <AuditMobileCardContent log={log} />
            )}
            pagination={
              logs.length > 0
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

function AuditMobileCardContent({ log }: { log: AuditLog }) {
  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-3">
        <UserBadge username={log.username} />
        <span className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-black text-slate-200">
          #{log.id}
        </span>
      </div>
      <div className="grid gap-3 text-sm">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'แอคชัน'}</div>
          <div className="mt-1 font-semibold text-white">{log.action}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'รายละเอียด'}</div>
          <div className="mt-1 break-words text-slate-200">{log.details || '\u2014'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'เวลา'}</div>
          <div className="mt-1 text-slate-200">{formatDateTime(log.createdAt)}</div>
        </div>
      </div>
    </>
  )
}
