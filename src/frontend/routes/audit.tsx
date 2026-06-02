import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { auditApi } from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { PageHeader } from '../components/ui/page-header'
import { formatDateTime } from '../lib/utils'
import { SkeletonTable } from '../components/ui/skeleton'
import { FileText, Search } from 'lucide-react'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import type { AuditLog, AuditQuery } from '../types'

export const Route = createFileRoute('/audit')({
  component: AuditComponent,
})

function UserBadge({ username }: { username: string }) {
  return (
    <span className="status-pill border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info">
      {username}
    </span>
  )
}

const AUDIT_COLUMNS: DataTableColumn<AuditLog>[] = [
  {
    header: 'ID',
    sortKey: 'id',
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
    sortKey: 'created_at',
    render: (log) => <span className="text-muted-foreground">{formatDateTime(log.createdAt)}</span>,
  },
]

function AuditComponent() {
  const [search, setSearch] = useState('')
  const [username, setUsername] = useState('')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [sortKey, setSortKey] = useState<NonNullable<AuditQuery['sortBy']>>('created_at')
  const [sortDir, setSortDir] = useState<NonNullable<AuditQuery['sortDir']>>('desc')
  const debouncedSearch = useDebouncedValue(search.trim(), 400)
  const debouncedUsername = useDebouncedValue(username.trim(), 300)
  const debouncedAction = useDebouncedValue(action.trim(), 300)

  const { data: result, isLoading } = useQuery({
    queryKey: ['audit', { search: debouncedSearch, username: debouncedUsername, action: debouncedAction, sortKey, sortDir, page, pageSize }],
    queryFn: () =>
      auditApi.paginated({
        search: debouncedSearch || undefined,
        username: debouncedUsername || undefined,
        action: debouncedAction || undefined,
        sortBy: sortKey,
        sortDir,
        page,
        pageSize,
      }),
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="space-y-5 sm:space-y-6">
        <Card className="glass border-white/10">
          <SkeletonTable rows={5} cols={4} />
        </Card>
      </div>
    )
  }

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
    <div className="space-y-5 page-enter sm:space-y-6">
      <PageHeader
        icon={FileText}
        title="ประวัติการใช้งาน"
        subtitle="ค้นหาและกรองกิจกรรมผู้ใช้"
      />

      <Card className="glass border-white/10">
        <CardContent className="p-5 sm:p-6">
          {/* Filters */}
          <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_auto]">
              <div className="space-y-2">
                <label htmlFor="audit-search" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'ค้นหา'}</label>
                <Input
                  id="audit-search"
                  placeholder={'ค้นหารายละเอียด'}
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="audit-username" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'ผู้ใช้'}</label>
                <Input
                  id="audit-username"
                  placeholder={'ผู้ใช้'}
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); setPage(1) }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="audit-action" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'แอคชัน'}</label>
                <Input
                  id="audit-action"
                  placeholder={'แอคชัน'}
                  value={action}
                  onChange={(e) => { setAction(e.target.value); setPage(1) }}
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
            densityKey="audit"
            emptyIcon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}
            emptyMessage={'ไม่พบประวัติการใช้งาน'}
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
            sorting={{
              sortKey,
              sortDir,
              onSortChange: (nextSortKey, nextSortDir) => {
                setSortKey((nextSortKey as AuditQuery['sortBy'] | null) ?? 'created_at')
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
