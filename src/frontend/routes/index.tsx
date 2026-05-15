import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rulesApi, metricsApi, lineApi, historyApi, auditApi, autoAcceptHistoryApi } from '../lib/api'
import { useSse } from '../hooks/useSse'
import { useAuth } from '../hooks/useAuth'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Skeleton, SkeletonCard } from '../components/ui/skeleton'
import { EmptyState } from '../components/EmptyState'
import { Sparkline } from '../components/Sparkline'
import { Activity, AlertTriangle, CheckCircle2, Clock, Database, Eye, FileText, Gauge, PauseCircle, Plus, Radio, Search, ShieldCheck, SignalHigh, Target, Truck, WifiOff, MessageSquare, Zap } from 'lucide-react'
import { formatDuration } from '../lib/utils'
import { useEffect, useState, useMemo } from 'react'
import { toast } from 'sonner'
import type { AuditLog, AutoAcceptHistoryItem, BookingHistory, NotifyRule, MetricsHistoryRow, TimingSummary, MetricsSnapshot, LineQuota } from '../types'
import { EditRuleDialog } from '../components/EditRuleDialog'
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog'
import { CreateRuleDialog } from '../components/CreateRuleDialog'
import { RulePreviewDialog } from '../components/RulePreviewDialog'
import { useMutation } from '@tanstack/react-query'

const SPARKLINE_COLORS = {
  success: '#86efac',
  latency: '#7dd3fc',
  trips: '#e8c76a',
}

export const Route = createFileRoute('/')({
  component: DashboardComponent,
})

function DashboardComponent() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<NotifyRule | null>(null)
  const [deletingRule, setDeletingRule] = useState<NotifyRule | null>(null)
  const [previewingRule, setPreviewingRule] = useState<NotifyRule | null>(null)

  const { data: rules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ['rules'],
    queryFn: rulesApi.list,
    staleTime: 2 * 60 * 1000,
  })

  const { data: initialMetrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: metricsApi.snapshot,
    staleTime: 5 * 1000,
  })

  const { data: historyData } = useQuery({
    queryKey: ['metrics-history'],
    queryFn: () => metricsApi.history(),
    staleTime: 5 * 60 * 1000,
  })

  const { data: lineQuota } = useQuery({
    queryKey: ['line-quota'],
    queryFn: lineApi.quota,
    refetchInterval: 60_000,
    staleTime: 60_000,
  })

  const { data: recentHistory = [] } = useQuery({
    queryKey: ['history', 'timeline'],
    queryFn: () => historyApi.list({ limit: 5, sortBy: 'created_at', sortDir: 'desc' }),
    staleTime: 60_000,
  })

  const { data: recentAudit = [] } = useQuery({
    queryKey: ['audit', 'timeline'],
    queryFn: () => auditApi.list({ limit: 5, sortBy: 'created_at', sortDir: 'desc' }),
    enabled: isAdmin,
    staleTime: 60_000,
  })

  const { data: recentAutoAccept = [] } = useQuery({
    queryKey: ['autoAcceptHistory', 'timeline'],
    queryFn: () => autoAcceptHistoryApi.list({ limit: 5, sortBy: 'created_at', sortDir: 'desc' }),
    enabled: isAdmin,
    staleTime: 60_000,
  })

  const { data: sseMetrics, rules: sseRules, sessionAlert } = useSse('/events')
  const metrics = sseMetrics || initialMetrics
  const hasSessionExpired = metrics?.lastPoll?.status === 'session_expired'
  const sessionAlertTimestamp = sessionAlert?.timestamp

  const togglePollerMutation = useMutation({
    mutationFn: () => metrics?.isPaused ? metricsApi.resume() : metricsApi.pause(),
    onSuccess: (data) => {
      toast.success(data.paused ? 'หยุดการทำงาน (Pause) เรียบร้อย' : 'เริ่มทำงาน (Resume) เรียบร้อย')
    },
    onError: (error) => {
      toast.error('ไม่สามารถเปลี่ยนสถานะได้: ' + error.message)
    }
  })

  useEffect(() => {
    if (sseRules) {
      queryClient.setQueryData(['rules'], sseRules)
    }
  }, [queryClient, sseRules])

  useEffect(() => {
    if (!sessionAlertTimestamp) return
    toast.error('SPX session หมดอายุ', {
      description: 'อัปเดต COOKIE ใหม่ใน Settings เพื่อให้ระบบ poll และ auto-accept กลับมาทำงาน',
      duration: 20_000,
    })
  }, [sessionAlertTimestamp])

  const { activeRules, fulfilledRules, disabledRules } = rules.reduce(
    (acc, r) => {
      if (r.enabled && !r.fulfilled) acc.activeRules++
      else if (r.fulfilled) acc.fulfilledRules++
      else if (!r.enabled) acc.disabledRules++
      return acc
    },
    { activeRules: 0, fulfilledRules: 0, disabledRules: 0 }
  )

  const quotaPercent = lineQuota?.limit
    ? Math.min(100, (lineQuota.totalUsage / lineQuota.limit) * 100)
    : 0

  const sparklineData = useMemo(() => {
    const raw = historyData as any
    const rows: MetricsHistoryRow[] = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : []
    return {
      success: rows.map((r: MetricsHistoryRow) => r.successRate ?? 0),
      latency: rows.map((r: MetricsHistoryRow) => Math.min(r.latencyP95, 5000)),
      trips: rows.map((r: MetricsHistoryRow) => r.requestCount ?? 0),
    }
  }, [historyData])

  if (rulesLoading) {
    return (
      <div className="space-y-3 sm:space-y-4">
        <Card className="glass border-white/10"><SkeletonCard lines={3} /></Card>
        <Card className="glass border-white/10"><SkeletonCard lines={5} /></Card>
      </div>
    )
  }

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Top Bar: Title + Stats */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <button
            onClick={() => togglePollerMutation.mutate()}
            disabled={togglePollerMutation.isPending}
            className={`mb-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] transition-colors hover:brightness-110 disabled:opacity-50 ${metrics?.isPaused ? 'border-amber-300/20 bg-amber-300/10 text-amber-300 hover:bg-amber-300/20' : 'border-cyan-300/20 bg-cyan-300/10 text-cyan-200 hover:bg-cyan-300/20'}`}
          >
            {metrics?.isPaused ? (
              <><PauseCircle className="h-3 w-3" />Paused</>
            ) : (
              <><Radio className="h-3 w-3 animate-pulse" />Live</>
            )}
          </button>
          <h1 className="text-xl font-black tracking-tight text-white sm:text-2xl">
            ภาพรวมระบบ
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {lineQuota?.limit ? (
            <div className="flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5">
              <MessageSquare className="h-3.5 w-3.5 text-emerald-300" />
              <span className="text-xs font-bold text-emerald-300">{lineQuota.totalUsage}/{lineQuota.limit}</span>
              <div className="h-1.5 w-12 rounded-full bg-white/20 overflow-hidden">
                <div className="h-full rounded-full bg-emerald-400 transition-[width] duration-500" style={{ width: `${Math.max(2, quotaPercent)}%` }} />
              </div>
            </div>
          ) : null}
          <Badge variant={metrics?.session?.isHealthy ? 'emerald' : 'amber'}>
            {metrics?.session?.isHealthy ? <SignalHigh className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {metrics?.session?.isHealthy ? 'Healthy' : 'Degraded'}
          </Badge>
          <Badge variant="cyan">
            <Target className="h-3 w-3" />
            {activeRules} active
          </Badge>
        </div>
      </div>

      {/* Session Expired Alert */}
      {hasSessionExpired ? (
        <div className="flex flex-col gap-2 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-red-50 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-300" />
            <span className="text-sm font-bold">SPX session หมดอายุ — อัปเดต COOKIE ใน Settings</span>
          </div>
          <Button asChild variant="outline" size="sm" className="border-red-300/40 text-red-50 hover:bg-red-400/10">
            <Link to="/settings">Settings</Link>
          </Button>
        </div>
      ) : null}

      {/* Stats Grid with Sparklines */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <MiniStat label="Active" value={activeRules} color="cyan" />
        <MiniStat label="Fulfilled" value={fulfilledRules} color="emerald" />
        <MiniStat label="Disabled" value={disabledRules} color="slate" />
        <MiniStat label="Success Rate" value={`${metrics?.polling?.successRate || 0}%`} color="emerald" sparkline={sparklineData.success} sparklineColor={SPARKLINE_COLORS.success} />
        <MiniStat label="P95 Latency" value={`${metrics?.polling?.latency?.p95 || 0}ms`} color="cyan" sparkline={sparklineData.latency} sparklineColor={SPARKLINE_COLORS.latency} />
        <MiniStat label="Uptime" value={formatDuration(metrics?.uptime || 0)} color="blue" />
      </div>

      {/* Health Center + Live Action Queue */}
      <div className="grid gap-3 sm:grid-cols-2">
        <HealthCenter metrics={metrics} lineQuota={lineQuota} rules={rules} />
        <LiveActionQueue metrics={metrics} rules={rules} hasSessionExpired={hasSessionExpired} />
      </div>

      <Card className="glass border-white/10">
        <CardHeader className="gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base text-white">Pipeline telemetry</CardTitle>
            <p className="text-xs text-muted-foreground">เวลาของแต่ละช่วงและแรงดันคิว detail แบบ real-time</p>
          </div>
          <Badge variant={metrics?.runtime?.queuedDetailBookings ? 'amber' : 'slate'}>
            {metrics?.runtime?.queuedDetailBookings ?? 0} queued
          </Badge>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <PipelineMetric label="Detail fetch" summary={metrics?.operations?.detailFetch} color="cyan" />
            <PipelineMetric label="DB save" summary={metrics?.operations?.dbSave} color="blue" />
            <PipelineMetric label="Notify" summary={metrics?.operations?.notify} color="amber" />
            <PipelineMetric label="Auto accept" summary={metrics?.operations?.autoAccept} color="emerald" />
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <MiniStat label="Detail jobs" value={metrics?.runtime ? `${metrics.runtime.activeDetailJobs}` : '—'} color="cyan" />
            <MiniStat label="Active bookings" value={metrics?.runtime ? `${metrics.runtime.activeDetailBookings}/${metrics.runtime.detailConcurrency || 0}` : '—'} color="blue" />
            <MiniStat label="Queue pressure" value={`${metrics?.runtime?.detailQueuePressure ?? 0}%`} color={(metrics?.runtime?.detailQueuePressure ?? 0) > 100 ? 'amber' : 'slate'} />
            <MiniStat label="SSE clients" value={metrics?.runtime?.sseClients ?? 0} color="emerald" />
          </div>
        </CardContent>
      </Card>

      <UnifiedTimeline
        metrics={metrics}
        history={recentHistory}
        auditLogs={recentAudit}
        autoAcceptHistory={recentAutoAccept}
        isAdmin={isAdmin}
      />

      {/* Rules Section */}
      <Card className="glass border-white/10">
        <CardHeader className="gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base text-white">รายการค้นหา</CardTitle>
            <p className="text-xs text-muted-foreground">
              จัดการ rule และดูสถานะได้ทันที
            </p>
          </div>
          <Button
            size="sm"
            className="bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20 hover:from-emerald-300 hover:to-cyan-300"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            เพิ่มรายการ
          </Button>
          <CreateRuleDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
        </CardHeader>
        <CardContent className="pt-0">
          {rules.length === 0 ? (
            <EmptyState icon={Search} title="ไม่มีรายการค้นหา" description="เพิ่ม rule แรกเพื่อเริ่มค้นหางาน bidding" action={
              <Button size="sm" className="bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950" onClick={() => setCreateDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" />เพิ่มรายการ
              </Button>
            } />
          ) : (
            <>
              <div className="grid gap-2 md:hidden">
                {rules.map((rule) => (
                  <RuleCard key={rule.id} rule={rule} onEdit={() => setEditingRule(rule)} onDelete={() => setDeletingRule(rule)} onPreview={() => setPreviewingRule(rule)} />
                ))}
              </div>
              <div className="data-scroll hidden md:block">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>สถานะ</th>
                      <th>ชื่อรายการ</th>
                      <th>ต้นทาง</th>
                      <th>ปลายทาง</th>
                      <th className="hidden lg:table-cell">ประเภทรถ</th>
                      <th>ต้องการ</th>
                      <th>จัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <RuleRow key={rule.id} rule={rule} onEdit={() => setEditingRule(rule)} onDelete={() => setDeletingRule(rule)} onPreview={() => setPreviewingRule(rule)} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <EditRuleDialog rule={editingRule} open={editingRule !== null} onOpenChange={(open) => { if (!open) setEditingRule(null) }} />
      <DeleteConfirmDialog rule={deletingRule} open={deletingRule !== null} onOpenChange={(open) => { if (!open) setDeletingRule(null) }} />
      <RulePreviewDialog rule={previewingRule} open={previewingRule !== null} onOpenChange={(open) => { if (!open) setPreviewingRule(null) }} />
    </div>
  )
}

function HealthCenter({ metrics, lineQuota, rules }: {
  metrics: MetricsSnapshot | null | undefined
  lineQuota: LineQuota | null | undefined
  rules: NotifyRule[]
}) {
  const checks = useMemo(() => {
    const items: { label: string; status: 'ok' | 'warning' | 'critical'; icon: typeof CheckCircle2 }[] = []

    const sessionOk = metrics?.lastPoll?.status !== 'session_expired'
    items.push({
      label: sessionOk ? 'SPX Session' : 'SPX Session หมดอายุ',
      status: sessionOk ? 'ok' : 'critical',
      icon: sessionOk ? CheckCircle2 : AlertTriangle,
    })

    const pollingOk = metrics && !metrics.isPaused && metrics.lastPoll?.status !== 'error'
    items.push({
      label: pollingOk ? 'Polling' : metrics?.isPaused ? 'Polling paused' : 'Polling error',
      status: pollingOk ? 'ok' : metrics?.isPaused ? 'warning' : 'critical',
      icon: pollingOk ? CheckCircle2 : AlertTriangle,
    })

    const pool = metrics?.database
    const dbOk = !pool || (pool.queuedRequests === 0 && pool.acquiredConnections < pool.connectionLimit)
    items.push({
      label: dbOk ? 'Database pool' : 'DB pool pressured',
      status: dbOk ? 'ok' : 'warning',
      icon: dbOk ? CheckCircle2 : Database,
    })

    const pressure = metrics?.runtime?.detailQueuePressure ?? 0
    const queueOk = pressure < 100
    items.push({
      label: queueOk ? 'Detail queue' : `Queue pressure ${pressure}%`,
      status: queueOk ? 'ok' : pressure >= 150 ? 'critical' : 'warning',
      icon: queueOk ? CheckCircle2 : Gauge,
    })

    const lineOk = !lineQuota?.limit || lineQuota.totalUsage < lineQuota.limit
    items.push({
      label: lineOk ? 'LINE Quota' : 'LINE Quota near limit',
      status: lineOk ? 'ok' : 'warning',
      icon: lineOk ? CheckCircle2 : MessageSquare,
    })

    const autoAcceptRules = rules.filter((r) => r.enabled && !r.fulfilled && r.auto_accept).length
    items.push({
      label: autoAcceptRules > 0 ? `${autoAcceptRules} auto-accept active` : 'No auto-accept rules',
      status: autoAcceptRules > 0 ? 'ok' : 'warning',
      icon: autoAcceptRules > 0 ? CheckCircle2 : ShieldCheck,
    })

    return items
  }, [metrics, lineQuota, rules])

  const okCount = checks.filter((c) => c.status === 'ok').length
  const overall = okCount === checks.length ? 'ok' : okCount >= checks.length - 2 ? 'warning' : 'critical'

  return (
    <Card className="glass border-white/10">
      <CardHeader className="gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-300" />
          <CardTitle className="text-base text-white">Health Center</CardTitle>
        </div>
        <Badge variant={overall === 'ok' ? 'emerald' : overall === 'warning' ? 'amber' : 'rose'}>
          {overall === 'ok' ? 'Healthy' : overall === 'warning' ? 'Degraded' : 'Critical'}
        </Badge>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-2">
          {checks.map((c) => (
            <div key={c.label} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2">
              <c.icon className={`h-4 w-4 shrink-0 ${c.status === 'ok' ? 'text-emerald-300' : c.status === 'warning' ? 'text-amber-300' : 'text-rose-300'}`} />
              <span className="flex-1 text-sm text-slate-200">{c.label}</span>
              <span className={`text-[0.65rem] font-bold uppercase tracking-[0.12em] ${c.status === 'ok' ? 'text-emerald-300' : c.status === 'warning' ? 'text-amber-300' : 'text-rose-300'}`}>
                {c.status === 'ok' ? 'OK' : c.status === 'warning' ? 'WARN' : 'CRIT'}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function LiveActionQueue({ metrics, rules, hasSessionExpired }: {
  metrics: MetricsSnapshot | null | undefined
  rules: NotifyRule[]
  hasSessionExpired: boolean
}) {
  const items = useMemo(() => {
    const queue: { label: string; action: string; to: string; variant: 'rose' | 'amber' | 'cyan' }[] = []

    if (hasSessionExpired) {
      queue.push({ label: 'SPX session หมดอายุ', action: 'อัปเดต COOKIE', to: '/settings', variant: 'rose' })
    }

    if (metrics?.isPaused) {
      queue.push({ label: 'Poller หยุดอยู่', action: 'Resume polling', to: '/settings', variant: 'amber' })
    }

    const pressure = metrics?.runtime?.detailQueuePressure ?? 0
    if (pressure >= 100) {
      queue.push({ label: `Queue pressure ${pressure}%`, action: 'รอเคลียร์', to: '/history', variant: 'amber' })
    }

    const failed = metrics?.autoAccept?.failureCount ?? 0
    if (failed > 0) {
      queue.push({ label: `Auto-accept failed ${failed} ครั้ง`, action: 'ตรวจสอบ', to: '/auto-accept-history', variant: 'amber' })
    }

    const fulfilledRules = rules.filter((r) => r.fulfilled)
    if (fulfilledRules.length > 0) {
      queue.push({ label: `${fulfilledRules.length} rule ครบจำนวนแล้ว`, action: 'ตรวจสอบ rule', to: '/history', variant: 'cyan' })
    }

    const activeRules = rules.filter((r) => r.enabled && !r.fulfilled)
    if (activeRules.length === 0 && rules.length > 0) {
      queue.push({ label: 'ไม่มี rule ที่เปิดอยู่', action: 'เปิด rule', to: '/', variant: 'cyan' })
    }

    return queue
  }, [metrics, rules, hasSessionExpired])

  return (
    <Card className="glass border-white/10">
      <CardHeader className="gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-300" />
          <CardTitle className="text-base text-white">Live Action Queue</CardTitle>
        </div>
        <Badge variant={items.length > 0 ? 'amber' : 'emerald'}>
          {items.length > 0 ? `${items.length} pending` : 'All clear'}
        </Badge>
      </CardHeader>
      <CardContent className="pt-0">
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/10 bg-white/[0.03] py-8 text-muted-foreground">
            <ShieldCheck className="h-8 w-8 text-emerald-300 opacity-50" />
            <p className="text-sm">ไม่มี action ที่ต้องทำตอนนี้</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <Link
                key={item.label}
                to={item.to}
                className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 transition-colors hover:bg-white/[0.06]"
              >
                <span className="flex-1 text-sm text-slate-200">{item.label}</span>
                <span className={`text-[0.65rem] font-bold uppercase tracking-[0.12em] ${item.variant === 'rose' ? 'text-rose-300' : item.variant === 'amber' ? 'text-amber-300' : 'text-cyan-300'}`}>
                  {item.action}
                </span>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type TimelineTone = 'cyan' | 'emerald' | 'amber' | 'rose' | 'slate'

interface TimelineItem {
  key: string
  timeMs: number
  title: string
  detail: string
  tone: TimelineTone
  icon: typeof Clock
}

function parseTimeMs(value: string | null | undefined) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function formatTimelineTime(timeMs: number) {
  if (!timeMs) return 'n/a'
  return new Intl.DateTimeFormat('th-TH', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timeMs))
}

function timelineToneClasses(tone: TimelineTone) {
  return {
    cyan: 'border-cyan-300/20 bg-cyan-300/10 text-cyan-200',
    emerald: 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200',
    amber: 'border-amber-300/20 bg-amber-300/10 text-amber-200',
    rose: 'border-rose-300/20 bg-rose-300/10 text-rose-200',
    slate: 'border-slate-300/20 bg-slate-300/10 text-slate-200',
  }[tone]
}

function UnifiedTimeline({ metrics, history, auditLogs, autoAcceptHistory, isAdmin }: {
  metrics: MetricsSnapshot | null | undefined
  history: BookingHistory[]
  auditLogs: AuditLog[]
  autoAcceptHistory: AutoAcceptHistoryItem[]
  isAdmin: boolean
}) {
  const items = useMemo<TimelineItem[]>(() => {
    const timeline: TimelineItem[] = []

    if (metrics?.lastPoll?.timestamp) {
      const status = metrics.lastPoll.status || 'unknown'
      timeline.push({
        key: 'poll-last',
        timeMs: parseTimeMs(metrics.lastPoll.timestamp),
        title: `Poll ${status}`,
        detail: `${metrics.lastPoll.latencyMs ?? 0}ms · ${metrics.lastPoll.recordCount ?? 0} records`,
        tone: status === 'session_expired' ? 'rose' : status === 'error' ? 'amber' : 'emerald',
        icon: Radio,
      })
    }

    for (const row of history.slice(0, 5)) {
      timeline.push({
        key: `history-${row.requestId}`,
        timeMs: parseTimeMs(row.createdAt),
        title: row.bookingName || row.route || `Request ${row.requestId}`,
        detail: `${row.origin || '—'} -> ${row.destination || '—'} · ${row.vehicleType || '—'}`,
        tone: 'cyan',
        icon: Truck,
      })
    }

    for (const row of autoAcceptHistory.slice(0, 5)) {
      timeline.push({
        key: `auto-${row.id}`,
        timeMs: parseTimeMs(row.createdAt),
        title: `${row.status === 'success' ? 'Auto accepted' : 'Auto accept failed'} · ${row.ruleName}`,
        detail: `${row.acceptedCount} accepted · ${row.origin || '—'} -> ${row.destination || '—'}`,
        tone: row.status === 'success' ? 'emerald' : 'rose',
        icon: Target,
      })
    }

    for (const row of auditLogs.slice(0, 5)) {
      timeline.push({
        key: `audit-${row.id}`,
        timeMs: parseTimeMs(row.createdAt),
        title: row.action,
        detail: `${row.username}${row.details ? ` · ${row.details}` : ''}`,
        tone: 'slate',
        icon: FileText,
      })
    }

    return timeline.sort((a, b) => b.timeMs - a.timeMs).slice(0, 8)
  }, [auditLogs, autoAcceptHistory, history, metrics])

  return (
    <Card className="glass border-white/10">
      <CardHeader className="gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base text-white">
            <Clock className="h-4 w-4 text-cyan-300" />
            Unified Timeline
          </CardTitle>
          <p className="text-xs text-muted-foreground">รวม poll ล่าสุด, งานเข้า, auto-accept และ audit ในจุดเดียว</p>
        </div>
        <Badge variant={isAdmin ? 'cyan' : 'slate'}>{isAdmin ? 'Admin view' : 'Operator view'}</Badge>
      </CardHeader>
      <CardContent className="pt-0">
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-5 text-sm text-muted-foreground">
            ยังไม่มี timeline event ให้แสดง
          </div>
        ) : (
          <div className="relative space-y-2 before:absolute before:left-5 before:top-3 before:h-[calc(100%-1.5rem)] before:w-px before:bg-white/10">
            {items.map((item) => (
              <div key={item.key} className="relative flex gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.035] p-3">
                <div className={`z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${timelineToneClasses(item.tone)}`}>
                  <item.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate text-sm font-bold text-white">{item.title}</div>
                    <Badge variant={item.tone === 'rose' ? 'rose' : item.tone === 'amber' ? 'amber' : item.tone === 'emerald' ? 'emerald' : item.tone === 'cyan' ? 'cyan' : 'slate'}>
                      {formatTimelineTime(item.timeMs)}
                    </Badge>
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.detail}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MiniStat({ label, value, color, sparkline, sparklineColor }: {
  label: string
  value: string | number
  color: 'cyan' | 'emerald' | 'slate' | 'amber' | 'blue'
  sparkline?: number[]
  sparklineColor?: string
}) {
  const colorClasses: Record<string, string> = {
    cyan: 'border-cyan-300/20 bg-cyan-300/10 text-cyan-300',
    emerald: 'border-emerald-300/20 bg-emerald-300/10 text-emerald-300',
    slate: 'border-slate-300/20 bg-slate-300/10 text-slate-300',
    amber: 'border-amber-300/20 bg-amber-300/10 text-amber-300',
    blue: 'border-blue-300/20 bg-blue-300/10 text-blue-300',
  }

  return (
    <div className={`rounded-xl border px-3 py-2.5 ${colorClasses[color]}`}>
      <div className="flex items-center justify-between gap-1">
        <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60">{label}</div>
        {sparkline && sparkline.length > 0 && (
          <Sparkline data={sparkline} width={48} height={20} color={sparklineColor} />
        )}
      </div>
      <div className="text-lg font-black tracking-tight font-mono">{value}</div>
    </div>
  )
}

function PipelineMetric({ label, summary, color }: {
  label: string
  summary?: TimingSummary
  color: 'cyan' | 'emerald' | 'amber' | 'blue'
}) {
  const tone: Record<string, string> = {
    cyan: 'from-cyan-300/20 to-cyan-300/5 text-cyan-200',
    emerald: 'from-emerald-300/20 to-emerald-300/5 text-emerald-200',
    amber: 'from-amber-300/20 to-amber-300/5 text-amber-200',
    blue: 'from-blue-300/20 to-blue-300/5 text-blue-200',
  }

  return (
    <div className={`rounded-xl border border-white/10 bg-gradient-to-br ${tone[color]} px-3 py-2.5`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-70">{label}</div>
        <div className="font-mono text-[0.65rem] opacity-60">{summary?.count ?? 0}x</div>
      </div>
      <div className="mt-1 font-mono text-xl font-black tracking-tight">{summary?.p95 ?? 0}ms</div>
      <div className="mt-1 flex items-center justify-between text-[0.65rem] text-muted-foreground">
        <span>avg {summary?.avg ?? 0}ms</span>
        <span>last {summary?.lastMs ?? 0}ms</span>
      </div>
    </div>
  )
}

function getStatusBadge(rule: NotifyRule) {
  if (!rule.enabled) return <Badge variant="slate">ปิดอยู่</Badge>
  if (rule.fulfilled) return <Badge variant="emerald">ครบแล้ว</Badge>
  return <Badge variant="cyan">กำลังค้นหา</Badge>
}

function RuleActions({ onEdit, onDelete, onPreview }: { onEdit: () => void; onDelete: () => void; onPreview: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs text-cyan-200 hover:text-cyan-100 whitespace-nowrap" onClick={onPreview}><Eye className="h-3.5 w-3.5" />Preview</Button>
      <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs whitespace-nowrap" onClick={onEdit}>แก้ไข</Button>
      <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs text-red-300 hover:text-red-200 whitespace-nowrap" onClick={onDelete}>ลบ</Button>
    </div>
  )
}

function RuleCard({ rule, onEdit, onDelete, onPreview }: { rule: NotifyRule; onEdit: () => void; onDelete: () => void; onPreview: () => void }) {
  return (
    <div className="mobile-record">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="mb-1">{getStatusBadge(rule)}</div>
          <div className="text-sm font-bold text-white">{rule.name}</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-right">
          <div className="text-[0.6rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">Need</div>
          <div className="text-base font-black text-cyan-200">{rule.need}</div>
        </div>
      </div>
      <div className="grid gap-2 text-xs">
        <div className="flex gap-2"><span className="text-muted-foreground">ต้นทาง:</span><span className="text-slate-200">{rule.origins.join(', ') || '—'}</span></div>
        <div className="flex gap-2"><span className="text-muted-foreground">ปลายทาง:</span><span className="text-slate-200">{rule.destinations.join(', ') || '—'}</span></div>
        <div className="flex gap-2"><span className="text-muted-foreground">ประเภทรถ:</span><span className="text-slate-200">{rule.vehicle_types.join(', ') || '—'}</span></div>
      </div>
      <div className="mt-3 border-t border-white/10 pt-3"><RuleActions onEdit={onEdit} onDelete={onDelete} onPreview={onPreview} /></div>
    </div>
  )
}

function RuleRow({ rule, onEdit, onDelete, onPreview }: { rule: NotifyRule; onEdit: () => void; onDelete: () => void; onPreview: () => void }) {
  return (
    <tr>
      <td>{getStatusBadge(rule)}</td>
      <td className="font-semibold text-white">{rule.name}</td>
      <td className="text-muted-foreground">{rule.origins.join(', ') || '—'}</td>
      <td className="text-muted-foreground">{rule.destinations.join(', ') || '—'}</td>
      <td className="hidden text-muted-foreground lg:table-cell">{rule.vehicle_types.join(', ') || '—'}</td>
      <td className="text-muted-foreground">{rule.need} คัน</td>
      <td><RuleActions onEdit={onEdit} onDelete={onDelete} onPreview={onPreview} /></td>
    </tr>
  )
}
