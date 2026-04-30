import { createRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { rulesApi, metricsApi, lineApi } from '../lib/api'
import { useSse } from '../hooks/useSse'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { AlertTriangle, CheckCircle2, Clock3, PauseCircle, Plus, Radio, Search, SignalHigh, Target, WifiOff, MessageSquare } from 'lucide-react'
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

  const { data: lineQuota } = useQuery({
    queryKey: ['line-quota'],
    queryFn: lineApi.quota,
    refetchInterval: 60_000,
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

  const quotaPercent = lineQuota?.limit
    ? Math.min(100, (lineQuota.totalUsage / lineQuota.limit) * 100)
    : 0

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Compact Top Bar: Title + Stats + LINE */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-1 inline-flex items-center gap-1.5 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-cyan-200">
            <Radio className="h-3 w-3" />
            Live
          </div>
          <h1 className="text-xl font-black tracking-tight text-white sm:text-2xl">
            รายการค้นหาและสถานะระบบ
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
          <div className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold ${metrics?.session?.isHealthy ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-300' : 'border-amber-300/20 bg-amber-300/10 text-amber-300'}`}>
            {metrics?.session?.isHealthy ? <SignalHigh className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {metrics?.session?.isHealthy ? 'Healthy' : 'Degraded'}
          </div>
          <div className="flex items-center gap-1.5 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-xs font-bold text-cyan-300">
            <Target className="h-3.5 w-3.5" />
            {activeRules}
          </div>
        </div>
      </div>

      {/* Session Expired Alert */}
      {hasSessionExpired ? (
        <div className="reveal-up flex flex-col gap-2 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-red-50 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-300" />
            <span className="text-sm font-bold">SPX session หมดอายุ — อัปเดต COOKIE ใน Settings</span>
          </div>
          <Button asChild variant="outline" size="sm" className="border-red-300/40 text-red-50 hover:bg-red-400/10">
            <Link to="/settings">Settings</Link>
          </Button>
        </div>
      ) : null}

      {/* Compact Stats Grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <MiniStat label="Active" value={activeRules} color="cyan" />
        <MiniStat label="Fulfilled" value={fulfilledRules} color="emerald" />
        <MiniStat label="Disabled" value={disabledRules} color="slate" />
        <MiniStat label="Success" value={`${metrics?.polling?.successRate || 0}%`} color="emerald" />
        <MiniStat label="P95" value={`${metrics?.polling?.latency?.p95 || 0}ms`} color="cyan" />
        <MiniStat label="Uptime" value={formatDuration(metrics?.uptime || 0)} color="blue" />
      </div>

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

          <CreateRuleDialog
            open={createDialogOpen}
            onOpenChange={setCreateDialogOpen}
          />
        </CardHeader>
        <CardContent className="pt-0">
          {rules.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.03] py-10 text-center text-muted-foreground">
              <Search className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="text-sm">ไม่มีรายการค้นหา</p>
            </div>
          ) : (
            <>
              <div className="grid gap-2 md:hidden">
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

function MiniStat({ label, value, color }: { label: string; value: string | number; color: 'cyan' | 'emerald' | 'slate' | 'amber' | 'blue' }) {
  const colorClasses = {
    cyan: 'border-cyan-300/20 bg-cyan-300/10 text-cyan-300',
    emerald: 'border-emerald-300/20 bg-emerald-300/10 text-emerald-300',
    slate: 'border-slate-300/20 bg-slate-300/10 text-slate-300',
    amber: 'border-amber-300/20 bg-amber-300/10 text-amber-300',
    blue: 'border-blue-300/20 bg-blue-300/10 text-blue-300',
  }

  return (
    <div className={`rounded-xl border px-3 py-2 ${colorClasses[color]}`}>
      <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60">{label}</div>
      <div className="text-lg font-black tracking-tight">{value}</div>
    </div>
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
        className="h-8 px-2.5 text-xs whitespace-nowrap"
        onClick={onEdit}
      >
        แก้ไข
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2.5 text-xs text-red-300 hover:text-red-200 whitespace-nowrap"
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
        <div className="flex gap-2">
          <span className="text-muted-foreground">ต้นทาง:</span>
          <span className="text-slate-200">{rule.origins.join(', ') || '—'}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-muted-foreground">ปลายทาง:</span>
          <span className="text-slate-200">{rule.destinations.join(', ') || '—'}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-muted-foreground">ประเภทรถ:</span>
          <span className="text-slate-200">{rule.vehicle_types.join(', ') || '—'}</span>
        </div>
      </div>
      <div className="mt-3 border-t border-white/10 pt-3">
        <RuleActions onEdit={onEdit} onDelete={onDelete} />
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
        <RuleActions onEdit={onEdit} onDelete={onDelete} />
      </td>
    </tr>
  )
}
