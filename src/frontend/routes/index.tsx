import { useScopedMetrics } from '../hooks/useScopedMetrics'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { ErrorState } from '../components/ui/error-state'
import { currentTeamApi, rulesApi, metricsApi } from '../lib/api'
import { useSseStream } from '../hooks/useSseContext'
import { useAuth } from '../hooks/useAuth'
import { Button, buttonVariants } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { SkeletonCard } from '../components/ui/skeleton'
import { EmptyState } from '../components/EmptyState'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { FilterPanel, MobileRecordCard, PageShell } from '../components/layout/Page'
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
import type { AuthUser, NotifyRule, TimingSummary } from '../types'
import { EditRuleDialog } from '../components/EditRuleDialog'
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog'
import { CreateRuleDialog } from '../components/CreateRuleDialog'
import { RulePreviewDialog } from '../components/RulePreviewDialog'
import { ProviderAuthPanel } from '../components/ProviderAuthPanel'
import {
  DASHBOARD_STATUS_CLOCK_INTERVAL_MS,
  DASHBOARD_TEAM_RUNTIME_REFRESH_MS,
  getDashboardTeamControlState,
} from '../lib/dashboard-runtime-state'

export { DASHBOARD_POLL_FRESHNESS_MS, getDashboardTeamControlState } from '../lib/dashboard-runtime-state'

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

export function canShowOwnTeamProviderAuth(user: AuthUser | null): boolean {
  return user?.role === 'user' && typeof user.teamId === 'number'
}

export function getDashboardSessionRecovery(user: AuthUser | null) {
  if (canShowOwnTeamProviderAuth(user)) {
    return {
      title: 'SPX session หมดอายุ — เชื่อมต่อบัญชีผู้ให้บริการด้านล่าง',
      actionLabel: 'ไปยังบัญชีผู้ให้บริการ',
      href: '#provider-auth-panel',
    } as const
  }
  if (user?.role === 'admin') {
    return {
      title: 'SPX session หมดอายุ — เลือกทีมและจัดการบัญชีผู้ให้บริการในหน้า Teams',
      actionLabel: 'ไปที่หน้า Teams',
      href: '/teams',
    } as const
  }
  return {
    title: 'SPX session หมดอายุ — กรุณาติดต่อผู้ดูแลระบบเพื่อเชื่อมต่อบัญชีของทีม',
    actionLabel: null,
    href: null,
  } as const
}

export function DashboardComponent() {
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
  const [, setStatusClockTick] = useState(0)

  // Stable per-row handlers so memoized RuleRow does not re-render on every SSE
  // metrics tick (~6-7×/sec at a 150ms poll) — only when the rules data changes.
  const handleEditRule = useCallback((rule: NotifyRule) => setEditingRule(rule), [])
  const handleDeleteRule = useCallback((rule: NotifyRule) => setDeletingRule(rule), [])
  const handlePreviewRule = useCallback((rule: NotifyRule) => setPreviewingRule(rule), [])

  const { data: rules = [], isLoading: rulesLoading, isError: rulesIsError, error: rulesError, refetch: refetchRules } = useQuery({
    queryKey: ['rules'],
    queryFn: rulesApi.list,
    staleTime: 2 * 60 * 1000,
  })

  const { data: metrics, hasFreshSse, isError: metricsIsError, error: metricsError, refetch: refetchMetrics } = useScopedMetrics()

  const { data: history = [], isError: historyIsError, refetch: refetchHistory } = useQuery({
    queryKey: ['metrics-history', 60],
    queryFn: () => metricsApi.history(60),
    enabled: isAdmin,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const shouldLoadCurrentTeam = canShowOwnTeamProviderAuth(user)
  const { data: currentTeam, isError: teamIsError, error: teamError, refetch: refetchTeam } = useQuery({
    queryKey: ['current-team'],
    queryFn: currentTeamApi.get,
    enabled: shouldLoadCurrentTeam,
    refetchInterval: DASHBOARD_TEAM_RUNTIME_REFRESH_MS,
    staleTime: 10_000,
  })

  const { rules: sseRules, sessionAlert } = useSseStream()
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

  useEffect(() => {
    // Trigger aging during silence; metrics-driven renders use current wall time.
    const timer = window.setInterval(() => setStatusClockTick((tick) => tick + 1), DASHBOARD_STATUS_CLOCK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

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
        render: (rule) => <div><span className="font-data text-foreground">{rule.need} <span className="text-xs text-muted-foreground">คัน</span></span>{rule.accept_all && <p className="mt-1 max-w-40 whitespace-normal text-xs text-warning">เป้าหมาย · รับทั้ง booking อาจเกินได้</p>}</div>,
        sortValue: (rule) => rule.need,
      },
    )

    if (isAdmin) {
      columns.push({
        id: 'mode',
        header: 'โหมด',
        sortKey: 'mode',
        render: (rule) => rule.accept_all ? <Badge variant="warning">รับทั้ง booking</Badge> : <Badge variant="neutral">ตามจำนวนคัน</Badge>,
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
    metrics,
    nowMs: Date.now(),
    isMutating: toggleTeamMutation.isPending,
  })
  const hasSessionExpired = teamControlState.primaryLabel === 'Session expired'

  const primaryStatusClassName = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] transition-colors disabled:opacity-50 ${teamControlState.primaryTone === 'off'
    ? 'bg-white/[0.05] text-muted-foreground'
    : teamControlState.primaryTone === 'paused'
      ? 'bg-[color:var(--color-warning-soft)] text-warning'
      : teamControlState.primaryTone === 'error'
        ? 'bg-[color:var(--color-danger-soft)] text-danger'
        : teamControlState.primaryTone === 'unknown'
          ? 'bg-white/[0.05] text-muted-foreground'
          : 'bg-[color:var(--color-info-soft)] text-info'
    }`

  const primaryStatusContent = (
    <>
      {teamControlState.primaryTone === 'off' ? (
        <PowerOff className="h-3 w-3" />
      ) : teamControlState.primaryTone === 'paused' ? (
        <PauseCircle className="h-3 w-3" />
      ) : teamControlState.primaryTone === 'error' ? (
        <AlertTriangle className="h-3 w-3" />
      ) : teamControlState.primaryTone === 'unknown' ? (
        <WifiOff className="h-3 w-3" />
      ) : (
        <Radio className="h-3 w-3 animate-pulse" />
      )}
      {teamControlState.primaryLabel}
    </>
  )

  const statusGroup = (
    <div className="flex max-w-full flex-col items-start gap-1">
      <div
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] p-0.5 pr-2"
        role="status"
        aria-label={`สถานะ Worker: ${teamControlState.runtimeReason}; ${teamControlState.healthLabel}`}
      >
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
        <span className="h-3 w-px shrink-0 bg-white/10" aria-hidden="true" />
        {teamControlState.healthTone === 'healthy' ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-[0.65rem] font-semibold text-success">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
            <span className="truncate">{teamControlState.healthLabel}</span>
          </span>
        ) : teamControlState.healthTone === 'degraded' ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-[0.65rem] font-semibold text-warning">
            <WifiOff className="h-3 w-3 shrink-0" />
            <span className="truncate">{teamControlState.healthLabel}</span>
          </span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1 text-[0.65rem] font-semibold text-muted-foreground">
            <WifiOff className="h-3 w-3 shrink-0" />
            <span className="truncate">{teamControlState.healthLabel}</span>
          </span>
        )}
      </div>
      <span className="max-w-[22rem] text-xs leading-snug text-muted-foreground">
        {teamControlState.runtimeReason}
      </span>
    </div>
  )
  const sessionRecovery = getDashboardSessionRecovery(user)

  return (
    <PageShell>
      <PageHeader
        icon={LayoutDashboard}
        title="ภาพรวมระบบ"
        subtitle={isAdmin ? "Pipeline telemetry และ rule ที่กำลังทำงาน" : "รายการค้นหาและสถานะการทำงาน"}
        meta={statusGroup}
      />

      {hasSessionExpired ? (
        <div className="flex flex-col gap-2 rounded-xl border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] p-3 text-foreground sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
            <span className="text-sm font-bold">{sessionRecovery.title}</span>
          </div>
          {sessionRecovery.href && sessionRecovery.actionLabel ? (
            <a
              href={sessionRecovery.href}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {sessionRecovery.actionLabel}
            </a>
          ) : null}
        </div>
      ) : null}

      {shouldLoadCurrentTeam ? <ProviderAuthPanel /> : null}

      {shouldLoadCurrentTeam && teamIsError ? (
        <ErrorState title="โหลดสถานะทีมไม่สำเร็จ" error={teamError} onRetry={() => { void refetchTeam() }} />
      ) : null}

      {/* Pipeline timeline — only visible to admin */}
      {isAdmin ? (
        metricsIsError && !hasFreshSse ? (
          <ErrorState title="โหลดสถานะการทำงานไม่สำเร็จ" error={metricsError} onRetry={() => { void refetchMetrics() }} />
        ) : !metrics ? (
          <SkeletonCard lines={3} />
        ) : (
          <>
            {historyIsError ? (
              <ErrorState className="py-4" title="โหลดกราฟย้อนหลังไม่สำเร็จ" description="สถานะล่าสุดยังแสดงอยู่ ลองโหลดกราฟย้อนหลังอีกครั้ง" onRetry={() => { void refetchHistory() }} />
            ) : null}
            <PipelineTimeline metrics={metrics} history={historyIsError ? [] : history} />
          </>
        )
      ) : null}

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
            <ErrorState
              title="โหลดรายการค้นหาไม่สำเร็จ"
              error={rulesError}
              onRetry={() => { void refetchRules() }}
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
                  {/* Mobile View */}
                  <div className="md:hidden space-y-3">
                    {filteredRules.map((rule) => (
                      <RuleMobileCard
                        key={rule.id}
                        rule={rule}
                        isAdmin={isAdmin}
                        onEdit={() => handleEditRule(rule)}
                        onDelete={() => handleDeleteRule(rule)}
                        onPreview={() => handlePreviewRule(rule)}
                      />
                    ))}
                  </div>

                  {/* Desktop View */}
                  <div className="hidden md:block">
                    <DataTable
                      columns={ruleColumns}
                      data={filteredRules}
                      keyField={(rule) => rule.id}
                      densityKey="notify-rules"
                      minWidth={isAdmin ? '1120px' : '960px'}
                    />
                  </div>
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
export function PipelineTimeline({
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
  const poolRequests = Array.isArray(upstream?.connectionPools)
    ? upstream.connectionPools.reduce((sum, pool) => sum + (Number.isFinite(pool?.requests) ? pool.requests : 0), 0) : 0
  const reuseRatio = metrics?.teamId === null && upstream?.connectionScope === 'aggregate' && Number.isFinite(upstream.reuseRatio) && poolRequests > 0
    ? upstream.reuseRatio : null

  return (
    <Card className="bg-card border-white/10">
      <div className="flex flex-col gap-3 px-5 pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div>
          <h2 className="section-title">Pipeline telemetry</h2>
          <p className="section-subtitle">
            จาก fetch → save → notify → accept · real-time
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {reuseRatio !== null ? (
            <Badge
              variant={reuseRatio >= 80 ? 'success' : reuseRatio >= 50 ? 'warning' : 'neutral'}
              title={`${poolRequests.toLocaleString()} process-pool requests · ${(upstream?.connections ?? 0).toLocaleString()} new connections`}
            >
              {reuseRatio}% pool reuse
            </Badge>
          ) : upstream ? (
            <Badge variant="neutral" title="Physical connections are shared across teams in each process; a team reuse ratio is unavailable.">
              {upstream.connectionScope === 'process' || upstream.connectionScope === 'aggregate' ? 'Shared process pool' : 'Pool ownership unknown'}
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
        <div className="mt-4 border-t border-border pt-3" aria-label="ช่วงเวลาที่แอปสังเกต">
          <p className="text-xs text-muted-foreground">ช่วงเวลาที่แอปสังเกต · ไม่ใช่เวลาเผยแพร่จากผู้ให้บริการ</p>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {([
              ['รายการหน้าแรก', metrics?.operations?.biddingListPage1],
              ['หน้าแรก → เริ่มอ่านรายละเอียด', metrics?.operations?.page1ToDetailStart],
              ['พบรายการตรงเงื่อนไข → ส่งคำขอรับงาน', metrics?.operations?.firstMatchToAcceptStart],
              ['รับงานเสร็จ → เริ่มอ่านผลยืนยัน', metrics?.operations?.verificationQueueWait],
            ] as const).map(([label, summary]) => (
              <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="tabular-nums">{summary?.count ? `${summary.avg.toLocaleString()} ms · p95 ${summary.p95.toLocaleString()} ms` : 'ยังไม่มีข้อมูลสังเกต'}</dd>
              </div>
            ))}
          </dl>
        </div>
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

function RuleMobileCard({
  rule,
  isAdmin,
  onEdit,
  onDelete,
  onPreview,
}: {
  rule: NotifyRule
  isAdmin: boolean
  onEdit: () => void
  onDelete: () => void
  onPreview: () => void
}) {
  return (
    <MobileRecordCard>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {getStatusBadge(rule)}
            {isAdmin && (rule.teamName || rule.teamId) ? (
              <Badge variant="neutral" className="text-[10px]">
                {rule.teamName || `Team #${rule.teamId}`}
              </Badge>
            ) : null}
            {rule.accept_all ? <Badge variant="warning">รับทั้ง booking</Badge> : null}
          </div>
          <h3 className="mt-1.5 text-sm font-bold text-foreground break-words">{rule.name}</h3>
        </div>
        <div className="shrink-0 text-right">
          <span className="font-data text-base font-black text-foreground">{rule.need}</span>
          <span className="ml-1 text-xs text-muted-foreground">คัน</span>
          {rule.accept_all && <p className="max-w-28 text-xs text-warning">เป้าหมาย · อาจเกินได้</p>}
        </div>
      </div>

      <div className="mt-2.5 rounded-lg border border-white/[0.06] bg-black/20 p-2.5 text-xs space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground shrink-0 text-[10px] uppercase font-bold tracking-wider">ต้นทาง</span>
          <span className="text-foreground text-right truncate">{rule.origins.join(', ') || '—'}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground shrink-0 text-[10px] uppercase font-bold tracking-wider">ปลายทาง</span>
          <span className="text-foreground text-right truncate">{rule.destinations.join(', ') || '—'}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground shrink-0 text-[10px] uppercase font-bold tracking-wider">ประเภทรถ</span>
          <span className="text-foreground text-right truncate">{rule.vehicle_types.join(', ') || '—'}</span>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1 border-t border-white/[0.04] pt-2">
        <RuleActions onEdit={onEdit} onDelete={onDelete} onPreview={onPreview} />
      </div>
    </MobileRecordCard>
  )
}
