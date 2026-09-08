import { lazy, Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { LucideIcon } from 'lucide-react'
import { metricsApi, reportsApi } from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { ContentSection, EmptyPanel, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { StatCard } from '../components/ui/stat-card'
import { ErrorState } from '../components/ui/error-state'
import { Skeleton } from '../components/ui/skeleton'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileBarChart,
  FileText,
  Gauge,
} from 'lucide-react'
import type { MetricsHistoryRow } from '../types'

const MetricsChart = lazy(() => import('../components/MetricsChart'))

export const Route = createFileRoute('/reports')({
  component: ReportsComponent,
})

interface ReportTile {
  icon: LucideIcon
  tone: 'info' | 'success' | 'primary'
  title: string
  description: string
  onDownload: () => void
}

const TONE_CLASSES: Record<ReportTile['tone'], string> = {
  info: 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info',
  success: 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success',
  primary: 'border-primary/22 bg-primary/10 text-primary',
}

function ReportsComponent() {
  const tiles: ReportTile[] = [
    {
      icon: Activity,
      tone: 'info',
      title: 'Metrics Report',
      description: 'รายงาน metrics การทำงานของระบบ',
      onDownload: () => reportsApi.downloadMetrics(),
    },
    {
      icon: FileText,
      tone: 'success',
      title: 'History Report',
      description: 'รายงานประวัติการจองและรับงาน',
      onDownload: () => reportsApi.downloadHistory(),
    },
    {
      icon: FileBarChart,
      tone: 'primary',
      title: 'Audit Report',
      description: 'รายงานประวัติการใช้งานระบบ',
      onDownload: () => reportsApi.downloadAudit(),
    },
  ]

  const {
    data: history = [],
    isLoading: historyLoading,
    isError: historyError,
    error: historyErrorObj,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: ['metrics-history', 96],
    queryFn: () => metricsApi.history(96),
    staleTime: 60 * 1000,
  })

  return (
    <PageShell>
      <PageHeader
        icon={FileBarChart}
        title="รายงาน"
        subtitle="ดาวน์โหลดรายงาน CSV และดู metrics ย้อนหลัง"
      />

      <ContentSection>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="section-title">Metrics history</h2>
              <p className="section-subtitle">
                ค่าล่าสุด 96 จุด — refresh ทุก 60 วินาที
              </p>
            </div>
          </div>

          {historyLoading ? (
            <Skeleton className="h-64 w-full rounded-xl" />
          ) : historyError ? (
            <ErrorState
              title="โหลด metrics history ไม่สำเร็จ"
              error={historyErrorObj}
              onRetry={() => refetchHistory()}
            />
          ) : history.length === 0 ? (
            <EmptyPanel className="flex h-64 items-center justify-center py-0 text-sm">ยังไม่มีข้อมูล metrics</EmptyPanel>
          ) : (
            <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
              <MetricsChart rows={history} />
            </Suspense>
          )}

          <MetricsSummary rows={history} loading={historyLoading} />
      </ContentSection>

      <ContentSection>
          <h2 className="section-title mb-3">Export CSV</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {tiles.map((tile) => (
              <ReportTileCard key={tile.title} tile={tile} />
            ))}
          </div>
      </ContentSection>
    </PageShell>
  )
}

function MetricsSummary({ rows, loading }: { rows: MetricsHistoryRow[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    )
  }
  if (rows.length === 0) return null
  const last = rows[rows.length - 1]
  const totalRequests = rows.reduce((sum, r) => sum + (r.requestCount ?? 0), 0)
  const avgLatency = Math.round(rows.reduce((sum, r) => sum + (r.latencyAvg ?? 0), 0) / rows.length)
  const p95Latency = Math.round(rows.reduce((sum, r) => sum + (r.latencyP95 ?? 0), 0) / rows.length)
  const lastSuccess = Math.round((last?.successRate ?? 0) * 100) / 100

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <StatCard
        tone={lastSuccess >= 99 ? 'success' : lastSuccess >= 95 ? 'warning' : 'danger'}
        icon={lastSuccess >= 99 ? CheckCircle2 : AlertTriangle}
        label="Success rate"
        value={`${lastSuccess.toFixed(2)}%`}
        hint="ค่าล่าสุด"
      />
      <StatCard
        tone="info"
        icon={Gauge}
        label="Avg latency"
        value={`${avgLatency.toLocaleString()}ms`}
        hint="ทั้งช่วง"
      />
      <StatCard
        tone="warning"
        icon={Gauge}
        label="P95 latency"
        value={`${p95Latency.toLocaleString()}ms`}
        hint="ทั้งช่วง"
      />
      <StatCard
        tone="primary"
        icon={Activity}
        label="Total requests"
        value={totalRequests.toLocaleString()}
        hint={`${rows.length} จุด`}
      />
    </div>
  )
}

function ReportTileCard({ tile }: { tile: ReportTile }) {
  const Icon = tile.icon
  return (
    <Card className="glass border-white/10 transition-colors hover:border-white/15">
      <CardContent className="flex h-full flex-col gap-4 p-5">
        <div
          aria-hidden="true"
          className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border ${TONE_CLASSES[tile.tone]}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-foreground">{tile.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{tile.description}</p>
        </div>
        <Button variant="outline" className="w-full" onClick={tile.onDownload}>
          <Download className="h-4 w-4" />
          Download CSV
        </Button>
      </CardContent>
    </Card>
  )
}
