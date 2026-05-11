import { createRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { rulesApi, metricsApi, lineApi } from '../lib/api'
import { useSse } from '../hooks/useSse'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Skeleton, SkeletonCard } from '../components/ui/skeleton'
import { EmptyState } from '../components/EmptyState'
import { Sparkline } from '../components/Sparkline'
import { AlertTriangle, PauseCircle, Plus, Radio, Search, SignalHigh, Target, WifiOff, MessageSquare } from 'lucide-react'
import { formatDuration } from '../lib/utils'
import { useEffect, useState, useMemo } from 'react'
import { toast } from 'sonner'
import type { NotifyRule, MetricsHistoryRow } from '../types'
import { EditRuleDialog } from '../components/EditRuleDialog'
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog'
import { CreateRuleDialog } from '../components/CreateRuleDialog'
import { useMutation } from '@tanstack/react-query'

const SPARKLINE_COLORS = {
  success: '#86efac',
  latency: '#7dd3fc',
  trips: '#e8c76a',
}

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

  const { data: rules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ['rules'],
    queryFn: rulesApi.list,
  })

  const { data: initialMetrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: metricsApi.snapshot,
  })

  const { data: historyData } = useQuery({
    queryKey: ['metrics-history'],
    queryFn: () => metricsApi.history(),
  })

  const { data: lineQuota } = useQuery({
    queryKey: ['line-quota'],
    queryFn: lineApi.quota,
    refetchInterval: 60_000,
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
    const rows: MetricsHistoryRow[] = historyData || []
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
                  <RuleCard key={rule.id} rule={rule} onEdit={() => setEditingRule(rule)} onDelete={() => setDeletingRule(rule)} />
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
                      <RuleRow key={rule.id} rule={rule} onEdit={() => setEditingRule(rule)} onDelete={() => setDeletingRule(rule)} />
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
    </div>
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

function getStatusBadge(rule: NotifyRule) {
  if (!rule.enabled) return <Badge variant="slate">ปิดอยู่</Badge>
  if (rule.fulfilled) return <Badge variant="emerald">ครบแล้ว</Badge>
  return <Badge variant="cyan">กำลังค้นหา</Badge>
}

function RuleActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs whitespace-nowrap" onClick={onEdit}>แก้ไข</Button>
      <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs text-red-300 hover:text-red-200 whitespace-nowrap" onClick={onDelete}>ลบ</Button>
    </div>
  )
}

function RuleCard({ rule, onEdit, onDelete }: { rule: NotifyRule; onEdit: () => void; onDelete: () => void }) {
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
      <div className="mt-3 border-t border-white/10 pt-3"><RuleActions onEdit={onEdit} onDelete={onDelete} /></div>
    </div>
  )
}

function RuleRow({ rule, onEdit, onDelete }: { rule: NotifyRule; onEdit: () => void; onDelete: () => void }) {
  return (
    <tr>
      <td>{getStatusBadge(rule)}</td>
      <td className="font-semibold text-white">{rule.name}</td>
      <td className="text-muted-foreground">{rule.origins.join(', ') || '—'}</td>
      <td className="text-muted-foreground">{rule.destinations.join(', ') || '—'}</td>
      <td className="hidden text-muted-foreground lg:table-cell">{rule.vehicle_types.join(', ') || '—'}</td>
      <td className="text-muted-foreground">{rule.need} คัน</td>
      <td><RuleActions onEdit={onEdit} onDelete={onDelete} /></td>
    </tr>
  )
}
