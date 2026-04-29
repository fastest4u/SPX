import { createRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { rulesApi, metricsApi } from '../lib/api'
import { useSse } from '../hooks/useSse'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { AlertTriangle, CheckCircle2, Clock3, PauseCircle, Plus, Radio, Search, SignalHigh, Target, WifiOff } from 'lucide-react'
import { formatDuration } from '../lib/utils'
import { useEffect, useState, type ComponentType } from 'react'
import { toast } from 'sonner'
import type { NotifyRule } from '../types'
import { EditRuleDialog } from '../components/EditRuleDialog'
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog'
import { CreateRuleDialog } from '../components/CreateRuleDialog'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardComponent,
})

function DashboardComponent() {
  const queryClient = useQueryClient()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<NotifyRule | null>(null)
  const [deletingRule, setDeletingRule] = useState<NotifyRule | null>(null)

  const { data: rules = [] } = useQuery({
    queryKey: ['rules'],
    queryFn: rulesApi.list,
  })

  const { data: initialMetrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: metricsApi.snapshot,
  })

  const { status: sseStatus, data: sseMetrics, rules: sseRules, sessionAlert } = useSse('/events')
  const metrics = sseMetrics || initialMetrics
  const hasSessionExpired = metrics?.lastPoll?.status === 'session_expired'
  const sessionAlertTimestamp = sessionAlert?.timestamp

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

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="glass reveal-up grid gap-4 rounded-[2rem] border-white/10 p-5 sm:p-6 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-cyan-200">
            <Radio className="h-3.5 w-3.5" />
            Live Operations
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl lg:text-4xl">
            รายการค้นหาและสถานะระบบ
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
            ควบคุม rule ค้นหางาน ตรวจสุขภาพ polling และติดตามผลแบบ real-time จากหน้าจอเดียว
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:min-w-80 lg:grid-cols-1">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Session</div>
            <div className={`mt-2 flex items-center gap-2 text-lg font-black ${metrics?.session?.isHealthy ? 'text-emerald-300' : 'text-amber-300'}`}>
              {metrics?.session?.isHealthy ? <SignalHigh className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
              {metrics?.session?.isHealthy ? 'Healthy' : 'Degraded'}
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Active Rules</div>
            <div className="mt-2 text-2xl font-black text-cyan-200">{activeRules}</div>
          </div>
        </div>
      </div>

      {hasSessionExpired ? (
        <div className="reveal-up flex flex-col gap-3 rounded-[1.5rem] border border-red-400/30 bg-red-500/10 p-4 text-red-50 shadow-[0_0_30px_-18px_rgba(248,113,113,0.9)] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <p className="font-bold">SPX session หมดอายุ</p>
              <p className="mt-1 text-sm text-red-100/80">
                ระบบกำลังได้รับ 401 จาก SPX API ต้องอัปเดต COOKIE ใหม่ใน Settings ก่อนถึงจะ poll และ auto-accept ได้
              </p>
            </div>
          </div>
          <Button asChild variant="outline" className="border-red-300/40 text-red-50 hover:bg-red-400/10">
            <a href="/settings">ไปที่ Settings</a>
          </Button>
        </div>
      ) : null}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          title="Active Rules"
          value={activeRules}
          color="cyan"
          icon={Target}
        />
        <KpiCard
          title="Fulfilled"
          value={fulfilledRules}
          color="emerald"
          icon={CheckCircle2}
        />
        <KpiCard
          title="Disabled"
          value={disabledRules}
          color="slate"
          icon={PauseCircle}
        />
        <KpiCard
          title="Status"
          value={metrics?.session?.isHealthy ? 'Healthy' : 'Degraded'}
          color={metrics?.session?.isHealthy ? 'emerald' : 'amber'}
          subtitle={`${metrics?.session?.consecutiveErrors || 0} consecutive errors`}
          icon={metrics?.session?.isHealthy ? SignalHigh : WifiOff}
        />
        <KpiCard
          title="Uptime"
          value={formatDuration(metrics?.uptime || 0)}
          color="blue"
          icon={Clock3}
        />
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Success Rate"
          value={`${metrics?.polling?.successRate || 0}%`}
          color="emerald"
        />
        <MetricCard
          title="P95 Latency"
          value={`${metrics?.polling?.latency?.p95 || 0} ms`}
          color="cyan"
        />
        <MetricCard
          title="Last Poll"
          value={metrics?.lastPoll?.timestamp
            ? new Date(metrics.lastPoll.timestamp).toLocaleTimeString('th-TH')
            : '—'}
          color="blue"
          subtitle={`Status: ${metrics?.lastPoll?.status || 'unknown'}`}
        />
        <SSEStatusCard status={sseStatus} />
      </div>

      {/* Rules Section */}
      <Card className="glass border-white/10">
        <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-white">รายการค้นหา</CardTitle>
            <p className="text-sm text-muted-foreground">
              จัดการ rule และดูสถานะได้ทันที
            </p>
          </div>
          <Button
            className="w-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20 hover:from-emerald-300 hover:to-cyan-300 sm:w-auto"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            เพิ่มรายการ
          </Button>

          <CreateRuleDialog
            open={createDialogOpen}
            onOpenChange={setCreateDialogOpen}
          />
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ไม่มีรายการค้นหา</p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:hidden">
                {rules.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    onEdit={() => setEditingRule(rule)}
                    onDelete={() => setDeletingRule(rule)}
                  />
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
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        onEdit={() => setEditingRule(rule)}
                        onDelete={() => setDeletingRule(rule)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <EditRuleDialog
        rule={editingRule}
        open={editingRule !== null}
        onOpenChange={(open) => {
          if (!open) setEditingRule(null)
        }}
      />
      <DeleteConfirmDialog
        rule={deletingRule}
        open={deletingRule !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingRule(null)
        }}
      />
    </div>
  )
}

function KpiCard({
  title,
  value,
  color,
  subtitle,
  icon: Icon,
}: {
  title: string
  value: string | number
  color: 'cyan' | 'emerald' | 'slate' | 'amber' | 'blue'
  subtitle?: string
  icon: ComponentType<{ className?: string }>
}) {
  const colorClasses = {
    cyan: { text: 'text-cyan-300', surface: 'border-cyan-300/20 bg-cyan-300/10' },
    emerald: { text: 'text-emerald-300', surface: 'border-emerald-300/20 bg-emerald-300/10' },
    slate: { text: 'text-slate-300', surface: 'border-slate-300/20 bg-slate-300/10' },
    amber: { text: 'text-amber-300', surface: 'border-amber-300/20 bg-amber-300/10' },
    blue: { text: 'text-blue-300', surface: 'border-blue-300/20 bg-blue-300/10' },
  }
  const classes = colorClasses[color]

  return (
    <Card className="glass border-white/10 transition-transform duration-200 hover:-translate-y-0.5">
      <CardContent className="p-4 sm:p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
            {title}
          </div>
          <div className={`rounded-2xl border p-2 ${classes.surface}`}>
            <Icon className={`h-4 w-4 ${classes.text}`} />
          </div>
        </div>
        <div className={`text-2xl font-black tracking-tight sm:text-3xl ${classes.text}`}>
          {value}
        </div>
        {subtitle ? (
          <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function MetricCard({
  title,
  value,
  color,
  subtitle,
}: {
  title: string
  value: string | number
  color: 'cyan' | 'emerald' | 'blue'
  subtitle?: string
}) {
  const colorClasses = {
    cyan: 'text-cyan-300',
    emerald: 'text-emerald-300',
    blue: 'text-blue-300',
  }

  return (
    <Card className="glass border-white/10">
      <CardContent className="p-4 sm:p-5">
        <div className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
          {title}
        </div>
        <div className={`text-2xl font-black tracking-tight ${colorClasses[color]}`}>{value}</div>
        {subtitle ? (
          <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function SSEStatusCard({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) {
  const statusConfig = {
    connected: { label: 'Live', color: 'text-emerald-400', dot: 'bg-emerald-400' },
    connecting: { label: 'Connecting...', color: 'text-amber-400', dot: 'bg-amber-400' },
    disconnected: { label: 'Offline', color: 'text-red-400', dot: 'bg-red-400' },
  }

  const config = statusConfig[status]

  return (
    <Card className="glass border-white/10">
      <CardContent className="flex items-center gap-3 p-4 sm:p-5">
        <div className={`h-3 w-3 rounded-full ${config.dot} ${status === 'connecting' ? 'animate-pulse' : ''}`} />
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">SSE Status</div>
          <div className={`text-lg font-black ${config.color}`}>{config.label}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function getStatusBadge(rule: NotifyRule) {
  if (!rule.enabled) {
    return <span className="status-pill border-slate-400/20 bg-slate-400/10 text-slate-300">ปิดอยู่</span>
  }
  if (rule.fulfilled) {
    return <span className="status-pill border-emerald-300/20 bg-emerald-300/10 text-emerald-300">ครบแล้ว</span>
  }
  return <span className="status-pill border-cyan-300/20 bg-cyan-300/10 text-cyan-300">กำลังค้นหา</span>
}

function RuleActions({
  onEdit,
  onDelete,
}: {
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-10 px-3 text-xs whitespace-nowrap"
        onClick={onEdit}
      >
        แก้ไข
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-10 px-3 text-xs text-red-300 hover:text-red-200 whitespace-nowrap"
        onClick={onDelete}
      >
        ลบ
      </Button>
    </div>
  )
}

function RuleCard({
  rule,
  onEdit,
  onDelete,
}: {
  rule: NotifyRule
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="mobile-record">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="mb-2">{getStatusBadge(rule)}</div>
          <div className="text-base font-black text-white">{rule.name}</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-right">
          <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">Need</div>
          <div className="text-lg font-black text-cyan-200">{rule.need}</div>
        </div>
      </div>
      <div className="grid gap-3 text-sm">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ต้นทาง</div>
          <div className="mt-1 text-slate-200">{rule.origins.join(', ') || '—'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ปลายทาง</div>
          <div className="mt-1 text-slate-200">{rule.destinations.join(', ') || '—'}</div>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ประเภทรถ</div>
          <div className="mt-1 text-slate-200">{rule.vehicle_types.join(', ') || '—'}</div>
        </div>
      </div>
      <div className="mt-4 border-t border-white/10 pt-4">
        <RuleActions
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
    </div>
  )
}

function RuleRow({
  rule,
  onEdit,
  onDelete,
}: {
  rule: NotifyRule
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <tr>
      <td>{getStatusBadge(rule)}</td>
      <td className="font-semibold text-white">{rule.name}</td>
      <td className="text-muted-foreground">
        {rule.origins.join(', ') || '—'}
      </td>
      <td className="text-muted-foreground">
        {rule.destinations.join(', ') || '—'}
      </td>
      <td className="hidden text-muted-foreground lg:table-cell">
        {rule.vehicle_types.join(', ') || '—'}
      </td>
      <td className="text-muted-foreground">{rule.need} คัน</td>
      <td>
        <RuleActions
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </td>
    </tr>
  )
}
