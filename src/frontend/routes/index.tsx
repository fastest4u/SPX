import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { currentTeamApi, rulesApi, metricsApi } from '../lib/api'
import { useSseStream } from '../hooks/useSseContext'
import { useAuth } from '../hooks/useAuth'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { SkeletonCard } from '../components/ui/skeleton'
import { EmptyState } from '../components/EmptyState'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { FilterPanel, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { Sparkline } from '../components/Sparkline'
import {
  AlertTriangle,
  Eye,
  LayoutDashboard,
  PauseCircle,
  PowerOff,
  Plus,
  Radio,
  Search,
  SlidersHorizontal,
  WifiOff,
  ChevronRight,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { AuthUser, NotifyRule, Team, TimingSummary } from '../types'
import { EditRuleDialog } from '../components/EditRuleDialog'
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog'
import { CreateRuleDialog } from '../components/CreateRuleDialog'
import { RulePreviewDialog } from '../components/RulePreviewDialog'

export const Route = createFileRoute('/')({
  component: DashboardComponent,
})

type RuleStatusFilter = 'all' | 'active' | 'fulfilled' | 'paused'

const ruleStatusOptions: Array<{ value: RuleStatusFilter; label: string }> = [
  { value: 'all', label: 'ทุกสถานะ' },
  { value: 'active', label: 'กำลังค้นหา' },
  { value: 'fulfilled', label: 'ครบแล้ว' },
  { value: 'paused', label: 'ปิดอยู่' },
]

const filterSelectClassName = 'h-10 w-full rounded-[8px] border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-foreground outline-none transition-colors hover:border-white/15 focus:border-ring focus:ring-2 focus:ring-ring/25'

type DashboardTeamControlState = {
  canToggle: boolean
  command: 'enable' | 'disable' | null
  disabled: boolean
  primaryLabel: 'Live' | 'Paused' | 'Off'
  primaryTone: 'live' | 'paused' | 'off'
  title: string
  healthLabel: 'Healthy' | 'Degraded'
  healthTone: 'healthy' | 'degraded'
}

export function getDashboardTeamControlState({
  user,
  team,
  isSystemPaused,
  isSessionHealthy,
  isMutating,
}: {
  user: AuthUser | null
  team?: Pick<Team, 'id' | 'name' | 'enabled' | 'runtimeStatus'> | null
  isSystemPaused: boolean
  isSessionHealthy: boolean
  isMutating: boolean
}): DashboardTeamControlState {
  const isOwnTeamUser = user?.role === 'user' && typeof user.teamId === 'number' && team?.id === user.teamId
  const teamEnabled = team ? team.enabled : !isSystemPaused
  const primaryLabel = teamEnabled ? (isSystemPaused && !team ? 'Paused' : 'Live') : 'Off'
  const primaryTone = primaryLabel === 'Off' ? 'off' : primaryLabel === 'Paused' ? 'paused' : 'live'
  const command = isOwnTeamUser ? (teamEnabled ? 'disable' : 'enable') : null
  const readonlyTitle = user?.role === 'admin'
    ? 'Admin ดูสถานะจาก Dashboard ได้เท่านั้น ใช้หน้า Teams เพื่อเปิดหรือปิดทีม'
    : 'ยังไม่พบทีมของผู้ใช้ จึงเปิดหรือปิดระบบบิทจาก Dashboard ไม่ได้'

  return {
    canToggle: isOwnTeamUser,
    command,
    disabled: !isOwnTeamUser || isMutating,
    primaryLabel,
    primaryTone,
    title: isOwnTeamUser
      ? `กดเพื่อ${teamEnabled ? 'ปิด' : 'เปิด'}ระบบบิทของทีม ${team.name}`
      : readonlyTitle,
    healthLabel: isSessionHealthy ? 'Healthy' : 'Degraded',
    healthTone: isSessionHealthy ? 'healthy' : 'degraded',
  }
}

function DashboardComponent() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<NotifyRule | null>(null)
  const [deletingRule, setDeletingRule] = useState<NotifyRule | null>(null)
  const [previewingRule, setPreviewingRule] = useState<NotifyRule | null>(null)
  const [ruleSearch, setRuleSearch] = useState('')
  const [ruleStatusFilter, setRuleStatusFilter] = useState<RuleStatusFilter>('all')
  const [ruleTeamFilter, setRuleTeamFilter] = useState('all')
  const [ruleVehicleFilter, setRuleVehicleFilter] = useState('all')

  // Stable per-row handlers so memoized RuleRow does not re-render on every SSE
  // metrics tick (~6-7×/sec at a 150ms poll) — only when the rules data changes.
  const handleEditRule = useCallback((rule: NotifyRule) => setEditingRule(rule), [])
  const handleDeleteRule = useCallback((rule: NotifyRule) => setDeletingRule(rule), [])
  const handlePreviewRule = useCallback((rule: NotifyRule) => setPreviewingRule(rule), [])

  const { data: rules = [], isLoading: rulesLoading, isError: rulesIsError, error: rulesError } = useQuery({
    queryKey: ['rules'],
    queryFn: rulesApi.list,
    staleTime: 2 * 60 * 1000,
  })

  const { data: initialMetrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: metricsApi.snapshot,
    staleTime: 5 * 1000,
  })

  const { data: history = [] } = useQuery({
    queryKey: ['metrics-history', 60],
    queryFn: () => metricsApi.history(60),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const shouldLoadCurrentTeam = user?.role === 'user' && typeof user.teamId === 'number'
  const { data: currentTeam } = useQuery({
    queryKey: ['current-team'],
    queryFn: currentTeamApi.get,
    enabled: shouldLoadCurrentTeam,
    staleTime: 10_000,
  })

  const { data: sseMetrics, rules: sseRules, sessionAlert } = useSseStream()
  const metrics = sseMetrics || initialMetrics
  const hasSessionExpired = metrics?.lastPoll?.status === 'session_expired'
  const sessionAlertTimestamp = sessionAlert?.timestamp

  const toggleTeamMutation = useMutation({
    mutationFn: () => {
      if (!currentTeam) throw new Error('TEAM_NOT_LOADED: Team status is not ready')
      return currentTeamApi.setEnabled(!currentTeam.enabled)
    },
    onSuccess: (team) => {
      queryClient.setQueryData(['current-team'], team)
      void queryClient.invalidateQueries({ queryKey: ['metrics'] })
      toast.success(team.enabled ? 'เปิดระบบบิทของทีมแล้ว' : 'ปิดระบบบิทของทีมแล้ว', {
        description: team.name,
      })
    },
    onError: (error) => {
      toast.error('ไม่สามารถเปลี่ยนสถานะได้: ' + error.message)
    },
  })

  useEffect(() => {
    if (sseRules) {
      if (isAdmin) {
        void queryClient.invalidateQueries({ queryKey: ['rules'] })
        return
      }
      queryClient.setQueryData(['rules'], sseRules)
    }
  }, [isAdmin, queryClient, sseRules])

  useEffect(() => {
    if (!sessionAlertTimestamp) return
    toast.error('SPX session หมดอายุ', {
      description:
        'อัปเดต SPX Cookie ใน Teams เพื่อให้ระบบ poll และ auto-accept ของทีมนั้นกลับมาทำงาน',
      duration: 20_000,
    })
  }, [sessionAlertTimestamp])

  const teamFilterOptions = useMemo(() => {
    const teams = new Map<string, string>()
    for (const rule of rules) {
      const id = rule.teamId == null ? 'none' : String(rule.teamId)
      if (!teams.has(id)) {
        teams.set(id, rule.teamName || (rule.teamId ? `Team #${rule.teamId}` : 'ไม่ระบุทีม'))
      }
    }
    return Array.from(teams, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'th'))
  }, [rules])

  const vehicleFilterOptions = useMemo(() => {
    const vehicles = new Set<string>()
    for (const rule of rules) {
      for (const vehicle of rule.vehicle_types) {
        if (vehicle.trim()) vehicles.add(vehicle.trim())
      }
    }
    return Array.from(vehicles).sort((a, b) => a.localeCompare(b, 'th'))
  }, [rules])

  const filteredRules = useMemo(() => {
    const normalizedSearch = ruleSearch.trim().toLowerCase()

    return rules.filter((rule) => {
      if (ruleStatusFilter !== 'all' && getRuleStatusKey(rule) !== ruleStatusFilter) return false
      if (ruleTeamFilter !== 'all') {
        const teamKey = rule.teamId == null ? 'none' : String(rule.teamId)
        if (teamKey !== ruleTeamFilter) return false
      }
      if (ruleVehicleFilter !== 'all' && !rule.vehicle_types.some((vehicle) => vehicle === ruleVehicleFilter)) return false
      if (!normalizedSearch) return true

      return [
        rule.name,
        rule.teamName,
        rule.teamId ? `Team #${rule.teamId}` : '',
        ...rule.origins,
        ...rule.destinations,
        ...rule.vehicle_types,
      ].some((value) => value?.toLowerCase().includes(normalizedSearch))
    })
  }, [ruleSearch, ruleStatusFilter, ruleTeamFilter, ruleVehicleFilter, rules])

  const activeRuleFilterCount = [
    ruleSearch.trim(),
    ruleStatusFilter !== 'all',
    ruleTeamFilter !== 'all',
    ruleVehicleFilter !== 'all',
  ].filter(Boolean).length

  const resetRuleFilters = useCallback(() => {
    setRuleSearch('')
    setRuleStatusFilter('all')
    setRuleTeamFilter('all')
    setRuleVehicleFilter('all')
  }, [])

  const ruleColumns = useMemo<DataTableColumn<NotifyRule>[]>(() => {
    const columns: DataTableColumn<NotifyRule>[] = [
      {
        id: 'status',
        header: 'สถานะ',
        required: true,
        sortable: false,
        render: (rule) => getStatusBadge(rule),
        sortValue: (rule) => getRuleStatusKey(rule),
      },
    ]

    if (isAdmin) {
      columns.push({
        id: 'team',
        header: 'ทีม',
        sortKey: 'team',
        render: (rule) => (
          <Badge variant="neutral">{rule.teamName || (rule.teamId ? `Team #${rule.teamId}` : 'ไม่ระบุทีม')}</Badge>
        ),
        sortValue: (rule) => rule.teamName || (rule.teamId ? `Team #${rule.teamId}` : 'ไม่ระบุทีม'),
      })
    }

    columns.push(
      {
        id: 'name',
        header: 'ชื่อรายการ',
        required: true,
        sortKey: 'name',
        render: (rule) => <span className="font-semibold text-foreground">{rule.name}</span>,
        sortValue: (rule) => rule.name,
      },
      {
        id: 'origins',
        header: 'ต้นทาง',
        sortKey: 'origins',
        render: (rule) => <span className="text-muted-foreground">{rule.origins.join(', ') || '—'}</span>,
        sortValue: (rule) => rule.origins.join(', '),
      },
      {
        id: 'destinations',
        header: 'ปลายทาง',
        sortKey: 'destinations',
        render: (rule) => <span className="text-muted-foreground">{rule.destinations.join(', ') || '—'}</span>,
        sortValue: (rule) => rule.destinations.join(', '),
      },
      {
        id: 'vehicle_types',
        header: 'ประเภทรถ',
        sortKey: 'vehicle_types',
        render: (rule) => <span className="text-muted-foreground">{rule.vehicle_types.join(', ') || '—'}</span>,
        sortValue: (rule) => rule.vehicle_types.join(', '),
      },
      {
        id: 'need',
        header: 'ต้องการ',
        sortKey: 'need',
        render: (rule) => <span className="font-data text-foreground">{rule.need} <span className="text-xs text-muted-foreground">คัน</span></span>,
        sortValue: (rule) => rule.need,
      },
    )

    if (isAdmin) {
      columns.push({
        id: 'mode',
        header: 'โหมด',
        sortKey: 'mode',
        render: (rule) => rule.accept_all ? <Badge variant="warning">accept_all</Badge> : <Badge variant="neutral">request ID</Badge>,
        sortValue: (rule) => rule.accept_all ? 'accept_all' : 'request ID',
      })
    }

    columns.push({
      id: 'actions',
      header: 'จัดการ',
      required: true,
      sortable: false,
      render: (rule) => (
        <RuleActions
          onEdit={() => handleEditRule(rule)}
          onDelete={() => handleDeleteRule(rule)}
          onPreview={() => handlePreviewRule(rule)}
        />
      ),
    })

    return columns
  }, [handleDeleteRule, handleEditRule, handlePreviewRule, isAdmin])

  if (rulesLoading) {
    return (
      <div className="space-y-3 sm:space-y-4">
        <Card className="bg-card border-white/10"><SkeletonCard lines={3} /></Card>
        <Card className="bg-card border-white/10"><SkeletonCard lines={5} /></Card>
      </div>
    )
  }

  const teamControlState = getDashboardTeamControlState({
    user,
    team: currentTeam,
    isSystemPaused: metrics?.isPaused ?? false,
    isSessionHealthy: metrics?.session?.isHealthy ?? true,
    isMutating: toggleTeamMutation.isPending,
  })

  const primaryStatusClassName = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] transition-colors disabled:opacity-50 ${teamControlState.primaryTone === 'off'
    ? 'bg-white/[0.05] text-muted-foreground'
    : teamControlState.primaryTone === 'paused'
      ? 'bg-[color:var(--color-warning-soft)] text-warning'
      : 'bg-[color:var(--color-info-soft)] text-info'
    }`

  const primaryStatusContent = (
    <>
      {teamControlState.primaryTone === 'off' ? (
        <PowerOff className="h-3 w-3" />
      ) : teamControlState.primaryTone === 'paused' ? (
        <PauseCircle className="h-3 w-3" />
      ) : (
        <Radio className="h-3 w-3 animate-pulse" />
      )}
      {teamControlState.primaryLabel}
    </>
  )

  const statusGroup = (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] p-0.5 pr-2">
      {teamControlState.canToggle ? (
        <button
          type="button"
          onClick={() => toggleTeamMutation.mutate()}
          disabled={teamControlState.disabled}
          className={primaryStatusClassName}
          title={teamControlState.title}
          aria-label={teamControlState.title}
        >
          {primaryStatusContent}
        </button>
      ) : (
        <span className={primaryStatusClassName} title={teamControlState.title}>
          {primaryStatusContent}
        </span>
      )}
      <span className="h-3 w-px bg-white/10" aria-hidden="true" />
      {teamControlState.healthTone === 'healthy' ? (
        <span className="inline-flex items-center gap-1 text-[0.65rem] font-semibold text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          {teamControlState.healthLabel}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-[0.65rem] font-semibold text-warning">
          <WifiOff className="h-3 w-3" />
          {teamControlState.healthLabel}
        </span>
      )}
    </div>
  )

  return (
    <PageShell>
      <PageHeader
        icon={LayoutDashboard}
        title="ภาพรวมระบบ"
        subtitle="Pipeline telemetry และ rule ที่กำลังทำงาน"
        meta={statusGroup}
      />

      {hasSessionExpired ? (
        <div className="flex flex-col gap-2 rounded-xl border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] p-3 text-foreground sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
            <span className="text-sm font-bold">SPX session หมดอายุ — อัปเดต Cookie ใน Teams</span>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/settings">Settings</Link>
          </Button>
        </div>
      ) : null}

      {/* Pipeline timeline — 4 stages as connected flow, not 4 lonely tiles. */}
      <PipelineTimeline metrics={metrics} history={history} />

      {/* Rules table */}
      <Card className="bg-card border-white/10">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div>
            <h2 className="section-title">รายการค้นหา</h2>
            <p className="section-subtitle">จัดการ rule และดูสถานะได้ทันที</p>
          </div>
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            เพิ่มรายการ
          </Button>
          <CreateRuleDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
        </div>
        <CardContent className="p-0">
          {rulesIsError ? (
            <EmptyState
              icon={AlertTriangle}
              title="โหลดรายการค้นหาไม่สำเร็จ"
              description={rulesError instanceof Error ? rulesError.message : 'ไม่สามารถโหลด rule ได้'}
              className="py-16"
            />
          ) : rules.length === 0 ? (
            <EmptyState
              icon={Search}
              title="ยังไม่มีกฎค้นหา"
              description="เริ่มจากกฎแรกเพื่อให้บอทเริ่มมองหางาน bidding ให้คุณ"
              action={
                <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="h-4 w-4" />
                  เพิ่มกฎแรก
                </Button>
              }
              className="py-16"
            />
          ) : (
            <div>
              <div className="border-b border-white/[0.06] px-4 py-4 sm:px-5">
                <RuleFilterPanel
                  activeFilterCount={activeRuleFilterCount}
                  filteredCount={filteredRules.length}
                  isAdmin={isAdmin}
                  onReset={resetRuleFilters}
                  search={ruleSearch}
                  setSearch={setRuleSearch}
                  setStatus={setRuleStatusFilter}
                  setTeam={setRuleTeamFilter}
                  setVehicle={setRuleVehicleFilter}
                  status={ruleStatusFilter}
                  team={ruleTeamFilter}
                  teamOptions={teamFilterOptions}
                  totalCount={rules.length}
                  vehicle={ruleVehicleFilter}
                  vehicleOptions={vehicleFilterOptions}
                />
              </div>

              {filteredRules.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="ไม่พบรายการที่ตรงกับตัวกรอง"
                  description="ลองล้างตัวกรองหรือค้นหาด้วยชื่อรายการ เส้นทาง ทีม หรือประเภทรถอื่น"
                  action={
                    <Button variant="outline" size="sm" onClick={resetRuleFilters}>
                      <X className="h-4 w-4" />
                      ล้างตัวกรอง
                    </Button>
                  }
                  className="py-14"
                />
              ) : (
                <div className="px-4 py-4 sm:px-5">
                  <DataTable
                    columns={ruleColumns}
                    data={filteredRules}
                    keyField={(rule) => rule.id}
                    densityKey="notify-rules"
                    minWidth={isAdmin ? '1120px' : '960px'}
                  />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <EditRuleDialog rule={editingRule} open={editingRule !== null} onOpenChange={(open) => { if (!open) setEditingRule(null) }} />
      <DeleteConfirmDialog rule={deletingRule} open={deletingRule !== null} onOpenChange={(open) => { if (!open) setDeletingRule(null) }} />
      <RulePreviewDialog rule={previewingRule} open={previewingRule !== null} onOpenChange={(open) => { if (!open) setPreviewingRule(null) }} />
    </PageShell>
  )
}

/* ─────────────────────────────────────────────────────────────
   Pipeline timeline
   Renders the critical-path stages connected by a flowing line. Each stage
   shows its p95 latency + inline sparkline of last 60 polls' avg latency.
   ───────────────────────────────────────────────────────────── */
function PipelineTimeline({
  metrics,
  history,
}: {
  metrics?: ReturnType<typeof useSseStream>['data']
  history: Array<{ latencyAvg: number; latencyP95: number; createdAt: string }>
}) {
  // history changes only every ~60s (refetchInterval), but this component re-renders
  // on every live SSE metrics tick — memoize so the sort/map doesn't run each render.
  const sparkData = useMemo(
    () =>
      history
        .slice()
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map((row) => row.latencyAvg),
    [history]
  )

  const stages: Array<{ label: string; summary?: TimingSummary; tone: string }> = [
    { label: 'Detail→1st', summary: metrics?.operations?.detailToFirstMatch, tone: 'var(--color-info)' },
    { label: 'Detail fetch', summary: metrics?.operations?.detailFetch, tone: 'var(--color-info)' },
    { label: 'Auto accept', summary: metrics?.operations?.autoAccept, tone: 'var(--color-success)' },
    { label: 'Accept RTT', summary: metrics?.operations?.acceptRtt, tone: 'var(--color-success)' },
    { label: 'Verify', summary: metrics?.operations?.autoAcceptVerify, tone: 'var(--color-warning)' },
    { label: 'Accept→verify', summary: metrics?.operations?.acceptToVerify, tone: 'var(--color-warning)' },
    { label: 'List age', summary: metrics?.operations?.listAgeMs, tone: 'var(--color-info)' },
    { label: 'DB save', summary: metrics?.operations?.dbSave, tone: 'var(--color-info)' },
    { label: 'Notify', summary: metrics?.operations?.notify, tone: 'var(--color-warning)' },
  ]

  const queued = metrics?.runtime?.queuedDetailBookings ?? 0
  const verifyQueued = metrics?.autoAccept?.pendingVerificationCount ?? 0
  const upstream = metrics?.upstream
  const reuseRatio = upstream && upstream.requests > 0 ? upstream.reuseRatio : null

  return (
    <Card className="bg-card border-white/10">
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <div>
          <h2 className="section-title">Pipeline telemetry</h2>
          <p className="section-subtitle">
            จาก fetch → save → notify → accept · real-time
          </p>
        </div>
        <div className="flex items-center gap-2">
          {reuseRatio !== null ? (
            <Badge
              variant={reuseRatio >= 80 ? 'success' : reuseRatio >= 50 ? 'warning' : 'neutral'}
              title={`${(upstream?.requests ?? 0).toLocaleString()} upstream reqs · ${(upstream?.connections ?? 0).toLocaleString()} new connections`}
            >
              {reuseRatio}% warm
            </Badge>
          ) : null}
          <Badge variant={queued ? 'warning' : 'neutral'}>
            {queued.toLocaleString()} queued
          </Badge>
          <Badge variant={verifyQueued ? 'warning' : 'neutral'}>
            {verifyQueued.toLocaleString()} verify
          </Badge>
        </div>
      </div>
      <CardContent className="p-5 pt-3">
        {/* Mobile: vertical timeline. Desktop: horizontal flow. */}
        <ol className="relative grid gap-3 lg:grid-cols-3 xl:grid-cols-9 lg:gap-0">
          {stages.map((stage, i) => (
            <PipelineStage
              key={stage.label}
              label={stage.label}
              summary={stage.summary}
              tone={stage.tone}
              sparkData={sparkData}
              isLast={i === stages.length - 1}
              index={i}
            />
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}

function PipelineStage({
  label,
  summary,
  tone,
  sparkData,
  isLast,
  index,
}: {
  label: string
  summary?: TimingSummary
  tone: string
  sparkData: number[]
  isLast: boolean
  index: number
}) {
  const p95 = summary?.p95 ?? 0
  const avg = summary?.avg ?? 0
  const count = summary?.count ?? 0

  return (
    <li className="relative flex flex-1 items-stretch gap-3 lg:flex-col lg:gap-2">
      {/* Connector — small arrow between stages on desktop */}
      {!isLast ? (
        <span
          aria-hidden="true"
          className="absolute right-0 top-1/2 hidden -translate-y-1/2 translate-x-1/2 text-muted-foreground/30 lg:inline-flex"
        >
          <ChevronRight className="h-5 w-5" />
        </span>
      ) : null}

      {/* Stage marker dot — keeps vertical mobile timeline anchored */}
      <span className="flex flex-col items-center gap-1 lg:hidden">
        <span
          className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: tone, boxShadow: `0 0 14px -3px ${tone}` }}
          aria-hidden="true"
        />
        {!isLast ? <span className="w-px flex-1 bg-white/10" aria-hidden="true" /> : null}
      </span>

      <div className="flex-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition-colors hover:border-white/[0.12] lg:mr-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.6rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            <span aria-hidden="true" className="opacity-50">0{index + 1}.</span>{' '}{label}
          </span>
          <span className="font-data text-[0.65rem] text-muted-foreground/60">{count}x</span>
        </div>
        <div className="mt-1.5 flex items-end justify-between gap-3">
          <div>
            <div className="font-data text-2xl font-black leading-none tracking-tight" style={{ color: tone }}>
              {p95}
              <span className="ml-0.5 text-xs font-semibold opacity-60">ms</span>
            </div>
            <div className="mt-1 text-[0.65rem] text-muted-foreground/80">
              avg {avg}ms
            </div>
          </div>
          {sparkData.length > 1 ? (
            <Sparkline data={sparkData} width={60} height={28} color={tone} />
          ) : (
            <div className="h-7 w-15 rounded bg-white/[0.03]" aria-hidden="true" />
          )}
        </div>
      </div>
    </li>
  )
}

function getStatusBadge(rule: NotifyRule) {
  if (!rule.enabled) return <Badge variant="neutral">ปิดอยู่</Badge>
  if (rule.fulfilled) return <Badge variant="success">ครบแล้ว</Badge>
  return <Badge variant="info">กำลังค้นหา</Badge>
}

function getRuleStatusKey(rule: NotifyRule): RuleStatusFilter {
  if (!rule.enabled) return 'paused'
  if (rule.fulfilled) return 'fulfilled'
  return 'active'
}

function RuleFilterPanel({
  activeFilterCount,
  filteredCount,
  isAdmin,
  onReset,
  search,
  setSearch,
  setStatus,
  setTeam,
  setVehicle,
  status,
  team,
  teamOptions,
  totalCount,
  vehicle,
  vehicleOptions,
}: {
  activeFilterCount: number
  filteredCount: number
  isAdmin: boolean
  onReset: () => void
  search: string
  setSearch: (value: string) => void
  setStatus: (value: RuleStatusFilter) => void
  setTeam: (value: string) => void
  setVehicle: (value: string) => void
  status: RuleStatusFilter
  team: string
  teamOptions: Array<{ value: string; label: string }>
  totalCount: number
  vehicle: string
  vehicleOptions: string[]
}) {
  return (
    <FilterPanel className="mb-0 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-primary/15 bg-primary/10 text-primary">
            <SlidersHorizontal className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-bold text-foreground">Filter panel</div>
            <div className="text-xs text-muted-foreground">
              แสดง {filteredCount.toLocaleString()} จาก {totalCount.toLocaleString()} รายการ
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={activeFilterCount === 0}
          className="self-start sm:self-auto"
        >
          <X className="h-4 w-4" />
          ล้างตัวกรอง{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </Button>
      </div>

      <div className={`grid gap-3 ${isAdmin ? 'lg:grid-cols-[minmax(14rem,1.4fr)_minmax(9rem,0.85fr)_minmax(9rem,0.9fr)_minmax(10rem,0.95fr)]' : 'lg:grid-cols-[minmax(14rem,1.5fr)_minmax(9rem,0.9fr)_minmax(10rem,1fr)]'}`}>
        <label className="space-y-1.5">
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ค้นหา</span>
          <span className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-10 rounded-[8px] border-white/[0.08] bg-white/[0.03] pl-9"
              placeholder="ชื่อรายการ, เส้นทาง, ทีม, ประเภทรถ"
            />
          </span>
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">สถานะ</span>
          <select
            className={filterSelectClassName}
            value={status}
            onChange={(event) => setStatus(event.target.value as RuleStatusFilter)}
          >
            {ruleStatusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {isAdmin ? (
          <label className="space-y-1.5">
            <span className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ทีม</span>
            <select
              className={filterSelectClassName}
              value={team}
              onChange={(event) => setTeam(event.target.value)}
            >
              <option value="all">ทุกทีม</option>
              {teamOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="space-y-1.5">
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ประเภทรถ</span>
          <select
            className={filterSelectClassName}
            value={vehicle}
            onChange={(event) => setVehicle(event.target.value)}
          >
            <option value="all">ทุกประเภท</option>
            {vehicleOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
    </FilterPanel>
  )
}

function RuleActions({ onEdit, onDelete, onPreview }: { onEdit: () => void; onDelete: () => void; onPreview: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-info hover:text-info" onClick={onPreview}>
        <Eye className="h-3.5 w-3.5" />
        Preview
      </Button>
      <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onEdit}>
        แก้ไข
      </Button>
      <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-danger hover:text-danger" onClick={onDelete}>
        ลบ
      </Button>
    </div>
  )
}
