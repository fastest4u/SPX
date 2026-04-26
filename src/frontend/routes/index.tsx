import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { rulesApi, metricsApi } from '../lib/api'
import { useSse } from '../hooks/useSse'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Plus, Search } from 'lucide-react'
import { formatDuration } from '../lib/utils'
import type { NotifyRule } from '../types'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardComponent,
})

function DashboardComponent() {
  const { data: rules = [] } = useQuery({
    queryKey: ['rules'],
    queryFn: rulesApi.list,
  })

  const { data: initialMetrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: metricsApi.snapshot,
  })

  const { status: sseStatus, data: sseMetrics } = useSse('/events')
  const metrics = sseMetrics || initialMetrics

  const activeRules = rules.filter((r) => r.enabled && !r.fulfilled).length
  const fulfilledRules = rules.filter((r) => r.fulfilled).length
  const disabledRules = rules.filter((r) => !r.enabled).length

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          title="Active Rules"
          value={activeRules}
          color="cyan"
        />
        <KpiCard
          title="Fulfilled"
          value={fulfilledRules}
          color="emerald"
        />
        <KpiCard
          title="Disabled"
          value={disabledRules}
          color="slate"
        />
        <KpiCard
          title="Status"
          value={metrics?.session?.isHealthy ? 'Healthy' : 'Degraded'}
          color={metrics?.session?.isHealthy ? 'emerald' : 'amber'}
          subtitle={`${metrics?.session?.consecutiveErrors || 0} consecutive errors`}
        />
        <KpiCard
          title="Uptime"
          value={formatDuration(metrics?.uptime || 0)}
          color="blue"
        />
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
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
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-white">รายการค้นหา</CardTitle>
            <p className="text-sm text-muted-foreground">
              จัดการ rule และดูสถานะได้ทันที
            </p>
          </div>
          <Button className="bg-cyan-500 hover:bg-cyan-600">
            <Plus className="h-4 w-4 mr-2" />
            เพิ่มรายการ
          </Button>
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ไม่มีรายการค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10 text-left text-sm text-muted-foreground">
                    <th className="pb-3 font-medium">สถานะ</th>
                    <th className="pb-3 font-medium">ชื่อรายการ</th>
                    <th className="pb-3 font-medium hidden md:table-cell">ต้นทาง</th>
                    <th className="pb-3 font-medium hidden md:table-cell">ปลายทาง</th>
                    <th className="pb-3 font-medium hidden lg:table-cell">ประเภทรถ</th>
                    <th className="pb-3 font-medium">ต้องการ</th>
                    <th className="pb-3 font-medium">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <RuleRow key={rule.id} rule={rule} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function KpiCard({
  title,
  value,
  color,
  subtitle,
}: {
  title: string
  value: string | number
  color: 'cyan' | 'emerald' | 'slate' | 'amber' | 'blue'
  subtitle?: string
}) {
  const colorClasses = {
    cyan: 'text-cyan-400 border-cyan-400/20 bg-cyan-400/10',
    emerald: 'text-emerald-400 border-emerald-400/20 bg-emerald-400/10',
    slate: 'text-slate-400 border-slate-400/20 bg-slate-400/10',
    amber: 'text-amber-400 border-amber-400/20 bg-amber-400/10',
    blue: 'text-blue-400 border-blue-400/20 bg-blue-400/10',
  }

  return (
    <Card className="glass border-white/10">
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
          {title}
        </div>
        <div className={`text-2xl font-bold ${colorClasses[color].split(' ')[0]}`}>
          {value}
        </div>
        {subtitle && (
          <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>
        )}
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
    cyan: 'text-cyan-400',
    emerald: 'text-emerald-400',
    blue: 'text-blue-400',
  }

  return (
    <Card className="glass border-white/10">
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
          {title}
        </div>
        <div className={`text-xl font-bold ${colorClasses[color]}`}>{value}</div>
        {subtitle && (
          <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>
        )}
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
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`w-3 h-3 rounded-full ${config.dot} ${status === 'connecting' ? 'animate-pulse' : ''}`} />
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">SSE Status</div>
          <div className={`font-medium ${config.color}`}>{config.label}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function RuleRow({ rule }: { rule: NotifyRule }) {
  const getStatusBadge = () => {
    if (!rule.enabled) {
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border border-slate-500/20 bg-slate-500/10 text-slate-400">ปิดอยู่</span>
    }
    if (rule.fulfilled) {
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border border-emerald-400/20 bg-emerald-400/10 text-emerald-400">ครบแล้ว</span>
    }
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border border-cyan-400/20 bg-cyan-400/10 text-cyan-400">กำลังค้นหา</span>
  }

  return (
    <tr className="border-b border-white/5 hover:bg-white/5 transition-colors">
      <td className="py-3">{getStatusBadge()}</td>
      <td className="py-3 text-white font-medium">{rule.name}</td>
      <td className="py-3 text-muted-foreground hidden md:table-cell">
        {rule.origins.join(', ') || '—'}
      </td>
      <td className="py-3 text-muted-foreground hidden md:table-cell">
        {rule.destinations.join(', ') || '—'}
      </td>
      <td className="py-3 text-muted-foreground hidden lg:table-cell">
        {rule.vehicle_types.join(', ') || '—'}
      </td>
      <td className="py-3 text-muted-foreground">{rule.need} คัน</td>
      <td className="py-3">
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className="h-8 text-xs">
            แก้ไข
          </Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs text-red-400 hover:text-red-300">
            ลบ
          </Button>
        </div>
      </td>
    </tr>
  )
}
