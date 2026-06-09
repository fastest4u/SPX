import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { rulesApi, metricsApi } from '../lib/api'
import { useSseStream } from '../hooks/useSseContext'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { SkeletonCard } from '../components/ui/skeleton'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/ui/page-header'
import { Sparkline } from '../components/Sparkline'
import {
  AlertTriangle,
  Eye,
  LayoutDashboard,
  PauseCircle,
  Plus,
  Radio,
  Search,
  WifiOff,
  ChevronRight,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, memo } from 'react'
import { toast } from 'sonner'
import type { NotifyRule, TimingSummary } from '../types'
import { EditRuleDialog } from '../components/EditRuleDialog'
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog'
import { CreateRuleDialog } from '../components/CreateRuleDialog'
import { RulePreviewDialog } from '../components/RulePreviewDialog'

export const Route = createFileRoute('/')({
  component: DashboardComponent,
})

function DashboardComponent() {
  const queryClient = useQueryClient()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<NotifyRule | null>(null)
  const [deletingRule, setDeletingRule] = useState<NotifyRule | null>(null)
  const [previewingRule, setPreviewingRule] = useState<NotifyRule | null>(null)

  // Stable per-row handlers so memoized RuleRow does not re-render on every SSE
  // metrics tick (~6-7×/sec at a 150ms poll) — only when the rules data changes.
  const handleEditRule = useCallback((rule: NotifyRule) => setEditingRule(rule), [])
  const handleDeleteRule = useCallback((rule: NotifyRule) => setDeletingRule(rule), [])
  const handlePreviewRule = useCallback((rule: NotifyRule) => setPreviewingRule(rule), [])

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

  const { data: history = [] } = useQuery({
    queryKey: ['metrics-history', 60],
    queryFn: () => metricsApi.history(60),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const { data: sseMetrics, rules: sseRules, sessionAlert } = useSseStream()
  const metrics = sseMetrics || initialMetrics
  const hasSessionExpired = metrics?.lastPoll?.status === 'session_expired'
  const sessionAlertTimestamp = sessionAlert?.timestamp

  const togglePollerMutation = useMutation({
    mutationFn: () =>
      metrics?.isPaused ? metricsApi.resume() : metricsApi.pause(),
    onSuccess: (data) => {
      toast.success(
        data.paused
          ? 'หยุดการทำงาน (Pause) เรียบร้อย'
          : 'เริ่มทำงาน (Resume) เรียบร้อย'
      )
    },
    onError: (error) => {
      toast.error('ไม่สามารถเปลี่ยนสถานะได้: ' + error.message)
    },
  })

  useEffect(() => {
    if (sseRules) {
      queryClient.setQueryData(['rules'], sseRules)
    }
  }, [queryClient, sseRules])

  useEffect(() => {
    if (!sessionAlertTimestamp) return
    toast.error('SPX session หมดอายุ', {
      description:
        'อัปเดต COOKIE ใหม่ใน Settings เพื่อให้ระบบ poll และ auto-accept กลับมาทำงาน',
      duration: 20_000,
    })
  }, [sessionAlertTimestamp])

  if (rulesLoading) {
    return (
      <div className="space-y-3 sm:space-y-4">
        <Card className="bg-card border-white/10"><SkeletonCard lines={3} /></Card>
        <Card className="bg-card border-white/10"><SkeletonCard lines={5} /></Card>
      </div>
    )
  }

  const statusGroup = (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] p-0.5 pr-2">
      <button
        onClick={() => togglePollerMutation.mutate()}
        disabled={togglePollerMutation.isPending}
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] transition-colors disabled:opacity-50 ${metrics?.isPaused
          ? 'bg-[color:var(--color-warning-soft)] text-warning'
          : 'bg-[color:var(--color-info-soft)] text-info'
          }`}
        title={metrics?.isPaused ? 'กดเพื่อเริ่มทำงาน' : 'กดเพื่อหยุดทำงาน'}
      >
        {metrics?.isPaused ? (
          <>
            <PauseCircle className="h-3 w-3" />
            Paused
          </>
        ) : (
          <>
            <Radio className="h-3 w-3 animate-pulse" />
            Live
          </>
        )}
      </button>
      <span className="h-3 w-px bg-white/10" aria-hidden="true" />
      {metrics?.session?.isHealthy ? (
        <span className="inline-flex items-center gap-1 text-[0.65rem] font-semibold text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          Healthy
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-[0.65rem] font-semibold text-warning">
          <WifiOff className="h-3 w-3" />
          Degraded
        </span>
      )}
    </div>
  )

  return (
    <div className="space-y-5">
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
            <span className="text-sm font-bold">SPX session หมดอายุ — อัปเดต COOKIE ใน Settings</span>
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
          {rules.length === 0 ? (
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
            <div className="data-scroll border-0 rounded-none">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>สถานะ</th>
                    <th>ชื่อรายการ</th>
                    <th>ต้นทาง</th>
                    <th>ปลายทาง</th>
                    <th>ประเภทรถ</th>
                    <th>ต้องการ</th>
                    <th>จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      onEdit={handleEditRule}
                      onDelete={handleDeleteRule}
                      onPreview={handlePreviewRule}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <EditRuleDialog rule={editingRule} open={editingRule !== null} onOpenChange={(open) => { if (!open) setEditingRule(null) }} />
      <DeleteConfirmDialog rule={deletingRule} open={deletingRule !== null} onOpenChange={(open) => { if (!open) setDeletingRule(null) }} />
      <RulePreviewDialog rule={previewingRule} open={previewingRule !== null} onOpenChange={(open) => { if (!open) setPreviewingRule(null) }} />
    </div>
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
    { label: 'DB save', summary: metrics?.operations?.dbSave, tone: 'var(--color-info)' },
    { label: 'Notify', summary: metrics?.operations?.notify, tone: 'var(--color-warning)' },
  ]

  const queued = metrics?.runtime?.queuedDetailBookings ?? 0
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
        </div>
      </div>
      <CardContent className="p-5 pt-3">
        {/* Mobile: vertical timeline. Desktop: horizontal flow. */}
        <ol className="relative grid gap-3 lg:grid-cols-6 lg:gap-0">
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

const RuleRow = memo(function RuleRow({ rule, onEdit, onDelete, onPreview }: { rule: NotifyRule; onEdit: (rule: NotifyRule) => void; onDelete: (rule: NotifyRule) => void; onPreview: (rule: NotifyRule) => void }) {
  return (
    <tr>
      <td>{getStatusBadge(rule)}</td>
      <td className="font-semibold text-foreground">{rule.name}</td>
      <td className="text-muted-foreground">{rule.origins.join(', ') || '—'}</td>
      <td className="text-muted-foreground">{rule.destinations.join(', ') || '—'}</td>
      <td className="text-muted-foreground">{rule.vehicle_types.join(', ') || '—'}</td>
      <td className="font-data text-foreground">{rule.need} <span className="text-xs text-muted-foreground">คัน</span></td>
      <td>
        <RuleActions onEdit={() => onEdit(rule)} onDelete={() => onDelete(rule)} onPreview={() => onPreview(rule)} />
      </td>
    </tr>
  )
})
