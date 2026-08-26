import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { auditApi } from '../lib/api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { ContentSection, FilterPanel, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { FilterChip } from '../components/ui/filter-chip'
import { formatDateTime } from '../lib/utils'
import { SkeletonTable } from '../components/ui/skeleton'
import { FileText, Search, SlidersHorizontal, X } from 'lucide-react'
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
  const [showFilters, setShowFilters] = useState(false)
  const [username, setUsername] = useState('')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [sortKey, setSortKey] = useState<NonNullable<AuditQuery['sortBy']>>('created_at')
  const [sortDir, setSortDir] = useState<NonNullable<AuditQuery['sortDir']>>('desc')
  const debouncedSearch = useDebouncedValue(search.trim(), 400)
  const debouncedUsername = useDebouncedValue(username.trim(), 300)
  const debouncedAction = useDebouncedValue(action.trim(), 300)

  const hasFilters = Boolean(search || username || action)

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
      <PageShell>
        <ContentSection>
          <SkeletonTable rows={5} cols={4} />
        </ContentSection>
      </PageShell>
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
    <PageShell>
      <PageHeader
        icon={FileText}
        title="ประวัติการใช้งาน"
        subtitle="ค้นหาและกรองกิจกรรมผู้ใช้"
      />

      <ContentSection>
          {/* Search Bar & Filter Toggle */}
          <div className="mb-4 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="ค้นหารายละเอียด..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(1)
                }}
                className="h-11 pl-10 pr-10 text-base"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('')
                    setPage(1)
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={`h-11 w-11 shrink-0 ${showFilters || hasFilters ? 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info' : ''}`}
              onClick={() => setShowFilters((value) => !value)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          {/* Expandable Filters */}
          {showFilters ? (
            <FilterPanel className="mb-4 space-y-3 animate-in">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-primary/15 bg-primary/10 text-primary">
                    <SlidersHorizontal className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-foreground">Filter panel</div>
                    <div className="text-xs text-muted-foreground">
                      กรองตาม ผู้ใช้, แอคชัน และรายละเอียด
                    </div>
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="self-start text-xs text-muted-foreground sm:self-auto" onClick={handleReset}>
                  ล้างทั้งหมด
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="audit-username" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">ผู้ใช้</label>
                  <Input
                    id="audit-username"
                    placeholder="ผู้ใช้"
                    value={username}
                    onChange={(e) => { setUsername(e.target.value); setPage(1) }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="audit-action" className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">แอคชัน</label>
                  <Input
                    id="audit-action"
                    placeholder="แอคชัน"
                    value={action}
                    onChange={(e) => { setAction(e.target.value); setPage(1) }}
                  />
                </div>
              </div>
            </FilterPanel>
          ) : null}

          {/* Active Filter Chips */}
          {hasFilters ? (
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              {search ? (
                <FilterChip label="ค้นหา" value={search} onClear={() => { setSearch(''); setPage(1) }} />
              ) : null}
              {username ? (
                <FilterChip label="ผู้ใช้" value={username} onClear={() => { setUsername(''); setPage(1) }} />
              ) : null}
              {action ? (
                <FilterChip label="แอคชัน" value={action} onClear={() => { setAction(''); setPage(1) }} />
              ) : null}
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={handleReset}>
                ล้างทั้งหมด
              </Button>
            </div>
          ) : null}

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
      </ContentSection>
    </PageShell>
  )
}
