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
    header: '\u0E1C\u0E39\u0E49\u0E17\u0E33\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23',
    render: (log) => <UserBadge username={log.username} />,
  },
  {
    header: '\u0E41\u0E2D\u0E04\u0E0A\u0E31\u0E19',
    render: (log) => <span className="text-muted-foreground">{log.action}</span>,
  },
  {
    header: '\u0E23\u0E32\u0E22\u0E25\u0E30\u0E40\u0E2D\u0E35\u0E22\u0E14',
    render: (log) => (
      <span className="max-w-md truncate text-muted-foreground block">
        {log.details || '\u2014'}
      </span>
    ),
  },
  {
    header: '\u0E40\u0E27\u0E25\u0E32',
    render: (log) => <span className="text-muted-foreground">{formatDateTime(log.createdAt)}</span>,
  },
]

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
          <CardTitle className="text-white">{'\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E01\u0E32\u0E23\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19'}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {'\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E41\u0E25\u0E30\u0E01\u0E23\u0E2D\u0E07\u0E01\u0E34\u0E08\u0E01\u0E23\u0E23\u0E21\u0E1C\u0E39\u0E49\u0E43\u0E0A\u0E49'}
          </p>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_auto]">
              <div className="space-y-2">
                <label htmlFor="audit-search" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E04\u0E49\u0E19\u0E2B\u0E32'}</label>
                <Input
                  id="audit-search"
                  placeholder={'\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E23\u0E32\u0E22\u0E25\u0E30\u0E40\u0E2D\u0E35\u0E22\u0E14'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="audit-username" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E1C\u0E39\u0E49\u0E43\u0E0A\u0E49'}</label>
                <Input
                  id="audit-username"
                  placeholder={'\u0E1C\u0E39\u0E49\u0E43\u0E0A\u0E49'}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="audit-action" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E41\u0E2D\u0E04\u0E0A\u0E31\u0E19'}</label>
                <Input
                  id="audit-action"
                  placeholder={'\u0E41\u0E2D\u0E04\u0E0A\u0E31\u0E19'}
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <Button className="w-full lg:w-auto" variant="outline" onClick={handleReset}>
                  {'\u0E25\u0E49\u0E32\u0E07'}
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
            emptyMessage={'\u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E01\u0E32\u0E23\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19'}
            renderMobile={(log) => (
              <AuditMobileCardContent log={log} />
            )}
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
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E41\u0E2D\u0E04\u0E0A\u0E31\u0E19'}</div>
          <div className="mt-1 font-semibold text-white">{log.action}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E23\u0E32\u0E22\u0E25\u0E30\u0E40\u0E2D\u0E35\u0E22\u0E14'}</div>
          <div className="mt-1 break-words text-slate-200">{log.details || '\u2014'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E40\u0E27\u0E25\u0E32'}</div>
          <div className="mt-1 text-slate-200">{formatDateTime(log.createdAt)}</div>
        </div>
      </div>
    </>
  )
}
