import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Info,
  Loader2,
  MessageCircle,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Stethoscope,
  Terminal,
  Wifi,
  Wrench,
  XCircle,
} from 'lucide-react'
import { servicesHealthApi } from '../lib/api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { ContentSection, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { StatCard } from '../components/ui/stat-card'
import { ErrorState } from '../components/ui/error-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { formatDuration } from '../lib/utils'
import type { DiagnosticCheckItem, ServiceItem } from '../types'

export const Route = createFileRoute('/services')({
  component: ServicesComponent,
})

type ServiceCategoryFilter = 'all' | 'core' | 'database' | 'notification' | 'poller'

const CATEGORY_FILTERS: Array<{ key: ServiceCategoryFilter; label: string }> = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'core', label: 'Core & API' },
  { key: 'database', label: 'ฐานข้อมูล (MySQL)' },
  { key: 'notification', label: 'LINE Bot' },
  { key: 'poller', label: 'Poller Workers' },
]

function getServiceCategoryIcon(category: ServiceItem['category']) {
  switch (category) {
    case 'core':
      return Server
    case 'database':
      return Database
    case 'notification':
      return MessageCircle
    case 'poller':
      return Cpu
    default:
      return Activity
  }
}

function getStateBadge(state: ServiceItem['state']) {
  switch (state) {
    case 'ok':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] px-2.5 py-0.5 text-xs font-semibold text-success">
          <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
          ปกติ (OK)
        </span>
      )
    case 'degraded':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] px-2.5 py-0.5 text-xs font-semibold text-warning">
          <span className="h-2 w-2 rounded-full bg-warning" />
          เฝ้าระวัง (Degraded)
        </span>
      )
    case 'down':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] px-2.5 py-0.5 text-xs font-semibold text-danger">
          <span className="h-2 w-2 rounded-full bg-danger" />
          มีปัญหา (Down)
        </span>
      )
  }
}

function ServicesComponent() {
  const queryClient = useQueryClient()
  const [categoryFilter, setCategoryFilter] = useState<ServiceCategoryFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedServiceToRestart, setSelectedServiceToRestart] = useState<ServiceItem | null>(null)
  const [restartReason, setRestartReason] = useState('')
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [pingingServiceId, setPingingServiceId] = useState<string | null>(null)
  const [pingResults, setPingResults] = useState<Record<string, { state: string; latencyMs?: number; message?: string }>>({})

  // Fetch Services Status every 15 seconds
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['services-status'],
    queryFn: () => servicesHealthApi.getStatus(),
    refetchInterval: 15_000,
  })

  // Deep diagnostics query/mutation
  const diagnosticsMutation = useMutation({
    mutationFn: () => servicesHealthApi.runDiagnostics(),
    onSuccess: (res) => {
      if (res.overallOk) {
        toast.success('ผลการตรวจวินิจฉัย: ระบบทุกส่วนทำงานสมบูรณ์ 100%')
      } else {
        toast.warning('ผลการตรวจวินิจฉัย: พบข้อบกพร่องบางรายการ โปรดดูคำแนะนำในการแก้ไข')
      }
    },
    onError: (err: Error) => {
      toast.error(`การตรวจวินิจฉัยล้มเหลว: ${err.message}`)
    },
  })

  // Ping mutation
  const pingMutation = useMutation({
    mutationFn: (serviceId: string) => servicesHealthApi.executeAction(serviceId, 'ping'),
    onSuccess: (res, serviceId) => {
      setPingingServiceId(null)
      const latencyStr = res.latencyMs !== undefined ? `(${res.latencyMs} ms)` : ''
      const msg = res.message || (res.state === 'ok' ? 'ตอบสนองปกติ' : 'สถานะไม่สมบูรณ์')
      setPingResults((prev) => ({
        ...prev,
        [serviceId]: { state: res.state || 'ok', latencyMs: res.latencyMs, message: msg },
      }))
      toast.success(`Ping ${serviceId}: ${msg} ${latencyStr}`)
    },
    onError: (err: Error, serviceId) => {
      setPingingServiceId(null)
      setPingResults((prev) => ({
        ...prev,
        [serviceId]: { state: 'down', message: err.message },
      }))
      toast.error(`Ping ${serviceId} ล้มเหลว: ${err.message}`)
    },
  })

  // Restart mutation
  const restartMutation = useMutation({
    mutationFn: ({ serviceId, reason }: { serviceId: string; reason?: string }) =>
      servicesHealthApi.executeAction(serviceId, 'restart', reason),
    onSuccess: (_res, variables) => {
      toast.success(`ส่งคำสั่ง Restart ไปยัง ${variables.serviceId} เรียบร้อยแล้ว`)
      setSelectedServiceToRestart(null)
      setRestartReason('')
      void queryClient.invalidateQueries({ queryKey: ['services-status'] })
    },
    onError: (err: Error) => {
      toast.error(`ส่งคำสั่ง Restart ไม่สำเร็จ: ${err.message}`)
    },
  })

  const handleRunDiagnostics = () => {
    setDiagnosticsOpen(true)
    diagnosticsMutation.mutate()
  }

  const handlePing = (serviceId: string) => {
    setPingingServiceId(serviceId)
    pingMutation.mutate(serviceId)
  }

  const handleConfirmRestart = () => {
    if (!selectedServiceToRestart) return
    restartMutation.mutate({
      serviceId: selectedServiceToRestart.id,
      reason: restartReason.trim() || undefined,
    })
  }

  // Filter services
  const filteredServices = useMemo(() => {
    if (!data?.services) return []
    return data.services.filter((s) => {
      if (categoryFilter !== 'all' && s.category !== categoryFilter) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const matchName = s.name.toLowerCase().includes(q)
        const matchHost = s.host.toLowerCase().includes(q)
        const matchNodeId = s.nodeId.toLowerCase().includes(q)
        const matchSummary = s.summary.toLowerCase().includes(q)
        return matchName || matchHost || matchNodeId || matchSummary
      }
      return true
    })
  }, [data?.services, categoryFilter, searchQuery])

  const overview = data?.overview

  return (
    <PageShell>
      <PageHeader
        title="สถานะระบบ & Services"
        subtitle="ตรวจสอบสถานะการทำงานแบบ Real-time, วินิจฉัยข้อผิดพลาดเชิงลึก และจัดการควบคุม Services ในระบบ SPX"
        icon={Activity}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRunDiagnostics}
              disabled={diagnosticsMutation.isPending}
              className="border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 hover:border-primary/50"
            >
              {diagnosticsMutation.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Stethoscope className="mr-1.5 h-4 w-4" />
              )}
              ตรวจวินิจฉัยเชิงลึก
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${isFetching ? 'animate-spin text-primary' : ''}`} />
              รีเฟรช
            </Button>
          </div>
        }
      />

      {isError && (
        <ErrorState
          title="ไม่สามารถโหลดข้อมูลสถานะระบบได้"
          description={error instanceof Error ? error.message : 'เกิดข้อผิดพลาดในการเชื่อมต่อ'}
          error={error}
          onRetry={() => void refetch()}
        />
      )}

      {/* KPI Overview Cards */}
      {overview && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4 sm:gap-4">
          <StatCard
            label="ภาพรวมระบบ"
            value={
              overview.overallState === 'ok'
                ? 'ปกติ (Healthy)'
                : overview.overallState === 'degraded'
                  ? 'เฝ้าระวัง (Degraded)'
                  : 'พบปัญหา (Down)'
            }
            tone={
              overview.overallState === 'ok'
                ? 'success'
                : overview.overallState === 'degraded'
                  ? 'warning'
                  : 'danger'
            }
            icon={ShieldCheck}
            hint={
              overview.overallState === 'ok'
                ? 'ระบบทุกส่วนทำงานได้อย่างสมบูรณ์'
                : 'มีบาง Service หรือ Node ที่ต้องตรวจสอบ'
            }
          />

          <StatCard
            label="Services พร้อมใช้งาน"
            value={`${overview.activeCount} / ${overview.totalCount}`}
            tone={overview.activeCount === overview.totalCount ? 'success' : 'warning'}
            icon={Server}
            hint={`${Math.round((overview.activeCount / (overview.totalCount || 1)) * 100)}% ของหน่วยบริการทั้งหมด`}
          />

          <StatCard
            label="ความเร็วฐานข้อมูลหลัก"
            value={`${overview.dbLatencyMs} ms`}
            tone={
              overview.dbLatencyMs < 100
                ? 'success'
                : overview.dbLatencyMs < 300
                  ? 'info'
                  : 'warning'
            }
            icon={Database}
            hint={
              overview.dbLatencyMs < 100
                ? 'ตอบสนองรวดเร็วมาก (Excellent)'
                : overview.dbLatencyMs < 300
                  ? 'ความเร็วปกติ (Normal)'
                  : 'ความเร็วตอบสนองค่อนข้างช้า'
            }
          />

          <StatCard
            label="เวลาทำงานต่อเนื่อง"
            value={formatDuration(overview.serverUptimeSeconds)}
            tone="primary"
            icon={Clock}
            hint="เซิร์ฟเวอร์หลักทำงานต่อเนื่อง (Uptime)"
          />
        </div>
      )}

      {/* Filter and Search Bar */}
      <ContentSection>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          {/* Category Tabs */}
          <div className="flex flex-wrap gap-1.5 p-1 bg-white/[0.04] border border-white/10 rounded-xl">
            {CATEGORY_FILTERS.map((cat) => (
              <button
                key={cat.key}
                type="button"
                onClick={() => setCategoryFilter(cat.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                  categoryFilter === cat.key
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Search Input */}
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="ค้นหาชื่อ Service, Host หรือ Node..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs"
            />
          </div>
        </div>
      </ContentSection>

      {/* Services Grid */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
          <p className="text-sm text-muted-foreground">กำลังตรวจสอบและรวบรวมสถานะ Services...</p>
        </div>
      ) : filteredServices.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center glass rounded-xl border border-white/10 p-8">
          <AlertCircle className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-base font-semibold text-foreground">ไม่พบบริการที่ตรงกับเงื่อนไข</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            ลองปรับเปลี่ยนคำค้นหา หรือเลือกตัวกรองประเภทบริการอื่น
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredServices.map((service) => {
            const Icon = getServiceCategoryIcon(service.category)
            const isPinging = pingingServiceId === service.id
            const pingResult = pingResults[service.id]

            return (
              <div
                key={service.id}
                className="group relative flex flex-col justify-between rounded-xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-sm transition-all duration-200 hover:border-white/20 hover:bg-white/[0.05] hover:shadow-lg"
              >
                <div>
                  {/* Top Row: Category Icon, Name, State Badge */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-primary">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-foreground line-clamp-1">
                          {service.name}
                        </h3>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[11px] font-mono text-muted-foreground">
                            ID: {service.id}
                          </span>
                          <span className="text-muted-foreground/40">•</span>
                          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                            {service.category}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div>{getStateBadge(service.state)}</div>
                  </div>

                  {/* Summary Box */}
                  <div className="rounded-lg border border-white/5 bg-black/20 p-2.5 mb-3.5">
                    <p className="text-xs text-foreground/90 leading-relaxed">
                      {service.summary}
                    </p>
                  </div>

                  {/* Technical Metadata Badges */}
                  <div className="grid grid-cols-2 gap-2 text-xs mb-4">
                    <div className="flex flex-col gap-0.5 rounded-lg border border-white/5 bg-white/[0.02] p-2">
                      <span className="text-[10px] uppercase text-muted-foreground font-semibold">Host / Server</span>
                      <span className="font-mono text-[11px] text-foreground/90 truncate" title={service.host}>
                        {service.host}
                      </span>
                    </div>

                    <div className="flex flex-col gap-0.5 rounded-lg border border-white/5 bg-white/[0.02] p-2">
                      <span className="text-[10px] uppercase text-muted-foreground font-semibold">Node Assignment</span>
                      <span className="font-mono text-[11px] text-foreground/90 truncate" title={service.nodeId}>
                        {service.nodeId}
                      </span>
                    </div>

                    {service.port !== null && (
                      <div className="flex flex-col gap-0.5 rounded-lg border border-white/5 bg-white/[0.02] p-2">
                        <span className="text-[10px] uppercase text-muted-foreground font-semibold">Port</span>
                        <span className="font-mono text-[11px] text-foreground/90">
                          :{service.port}
                        </span>
                      </div>
                    )}

                    {service.latencyMs !== null && (
                      <div className="flex flex-col gap-0.5 rounded-lg border border-white/5 bg-white/[0.02] p-2">
                        <span className="text-[10px] uppercase text-muted-foreground font-semibold">Latency</span>
                        <span className="font-mono text-[11px] text-success">
                          {service.latencyMs} ms
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Ping Result Alert if available */}
                  {pingResult && (
                    <div
                      className={`mb-3.5 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                        pingResult.state === 'ok'
                          ? 'border-success/30 bg-success/10 text-success'
                          : 'border-danger/30 bg-danger/10 text-danger'
                      }`}
                    >
                      <Radio className="h-3.5 w-3.5 shrink-0 animate-pulse" />
                      <span className="truncate">
                        Ping: {pingResult.message} {pingResult.latencyMs !== undefined ? `(${pingResult.latencyMs} ms)` : ''}
                      </span>
                    </div>
                  )}

                  {/* Technical Details Accordion / Extra info */}
                  {service.details && (
                    <div className="text-[11px] text-muted-foreground/80 mb-3 space-y-1">
                      {service.id === 'web-api' && (
                        <div className="flex items-center justify-between">
                          <span>Memory (RSS / Heap):</span>
                          <span className="font-mono text-foreground/90">
                            {String(service.details.memoryRssMb)} MB / {String(service.details.heapUsedMb)} MB
                          </span>
                        </div>
                      )}
                      {service.id === 'mysql-db' && service.details.poolStats ? (
                        <div className="flex items-center justify-between">
                          <span>Connection Pool:</span>
                          <span className="font-mono text-foreground/90">
                            {(service.details.poolStats as { totalConnections?: number })?.totalConnections ?? 0} total (
                            {(service.details.poolStats as { freeConnections?: number })?.freeConnections ?? 0} free)
                          </span>
                        </div>
                      ) : null}
                      {service.category === 'poller' && (
                        <div className="flex items-center justify-between">
                          <span>Desired State:</span>
                          <Badge variant="neutral" className="text-[10px] py-0 px-1.5">
                            {String(service.details.desiredState || 'unknown')}
                          </Badge>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Card Actions Footer */}
                <div className="flex items-center justify-between border-t border-white/10 pt-3.5 mt-2">
                  <div className="flex items-center gap-2">
                    {service.canPing && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePing(service.id)}
                        disabled={isPinging}
                        className="h-8 text-xs px-2.5"
                      >
                        {isPinging ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wifi className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        ทดสอบ Ping
                      </Button>
                    )}
                  </div>

                  <div>
                    {service.canRestart ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedServiceToRestart(service)}
                        className="h-8 text-xs px-2.5 border-warning/30 text-warning hover:bg-warning/10 hover:border-warning/50"
                      >
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        Restart
                      </Button>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/60 flex items-center gap-1">
                        <Info className="h-3 w-3" />
                        Managed by Host
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Restart Confirmation Dialog */}
      <Dialog
        open={Boolean(selectedServiceToRestart)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedServiceToRestart(null)
            setRestartReason('')
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-warning">
              <AlertTriangle className="h-5 w-5" />
              ยืนยันการ Restart Service
            </DialogTitle>
            <DialogDescription>
              คุณกำลังจะส่งคำสั่ง Restart ไปยัง{' '}
              <strong className="text-foreground">{selectedServiceToRestart?.name}</strong>{' '}
              (Host: {selectedServiceToRestart?.host})
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs text-warning/90 leading-relaxed">
              <strong>หมายเหตุ:</strong> ระบบจะสั่งตั้งค่า Desired State เป็น <code>restart</code>{' '}
              ซึ่งโหนด Worker จะทำการคืน Lease ปัจจุบัน ปิด Connection เก่า และสร้างลูปการ Polling ใหม่โดยอัตโนมัติภายใน 5-15 วินาที
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="restart-reason" className="text-xs">
                เหตุผลในการสั่ง Restart (ไม่บังคับ - จะถูกบันทึกใน Audit Log)
              </Label>
              <Input
                id="restart-reason"
                placeholder="เช่น: ลูปค้าง, บอทไม่ดึงข้อมูลรอบใหม่"
                value={restartReason}
                onChange={(e) => setRestartReason(e.target.value)}
                className="text-xs"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedServiceToRestart(null)}
              disabled={restartMutation.isPending}
            >
              ยกเลิก
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleConfirmRestart}
              disabled={restartMutation.isPending}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              {restartMutation.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  กำลังสั่งการ...
                </>
              ) : (
                <>
                  <RotateCcw className="mr-1.5 h-4 w-4" />
                  ยืนยัน Restart
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deep Diagnostics Dialog */}
      <Dialog open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Stethoscope className="h-5 w-5 text-primary" />
              การตรวจวินิจฉัยสุขภาพระบบเชิงลึก (Deep System Diagnostics)
            </DialogTitle>
            <DialogDescription>
              ตรวจสอบการจับมือสื่อสาร (Handshake), Latency และความพร้อมของทุกส่วนประกอบแบบเรียลไทม์
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-4 py-3 pr-1">
            {diagnosticsMutation.isPending ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Loader2 className="h-10 w-10 animate-spin text-primary mb-3" />
                <h4 className="text-sm font-semibold text-foreground">กำลังทดสอบเชื่อมต่อทุก Service...</h4>
                <p className="text-xs text-muted-foreground mt-1">
                  กำลังทดสอบ MySQL Handshake, LINE Health, LINE Ready Webhook และ Poller Nodes Heartbeat
                </p>
              </div>
            ) : diagnosticsMutation.isError ? (
              <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-xs text-danger">
                เกิดข้อผิดพลาดในการรันการตรวจวินิจฉัย: {diagnosticsMutation.error.message}
              </div>
            ) : diagnosticsMutation.data ? (
              <div className="space-y-4">
                {/* Result Overview Banner */}
                <div
                  className={`flex items-start gap-3 rounded-xl border p-4 ${
                    diagnosticsMutation.data.overallOk
                      ? 'border-success/30 bg-success/10 text-success'
                      : 'border-warning/30 bg-warning/10 text-warning'
                  }`}
                >
                  {diagnosticsMutation.data.overallOk ? (
                    <CheckCircle2 className="h-6 w-6 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="h-6 w-6 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <h4 className="text-sm font-bold">
                      {diagnosticsMutation.data.overallOk
                        ? 'ระบบทุกส่วนทำงานได้อย่างสมบูรณ์ 100%'
                        : 'ตรวจพบข้อบกพร่องบางรายการที่ต้องเฝ้าระวังหรือแก้ไข'}
                    </h4>
                    <p className="text-xs mt-1 text-foreground/80">
                      ตรวจเช็ก ณ เวลา{' '}
                      {new Date(diagnosticsMutation.data.timestamp).toLocaleString('th-TH', {
                        timeZone: 'Asia/Bangkok',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                </div>

                {/* Individual Checks List */}
                <div className="space-y-3">
                  {diagnosticsMutation.data.checks.map((check: DiagnosticCheckItem) => (
                    <div
                      key={check.id}
                      className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {check.state === 'ok' ? (
                            <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                          ) : check.state === 'degraded' ? (
                            <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-danger shrink-0" />
                          )}
                          <span className="text-sm font-semibold text-foreground">
                            {check.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-muted-foreground">
                            {check.latencyMs} ms
                          </span>
                          {getStateBadge(check.state)}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
                        <Terminal className="h-3 w-3" />
                        Target: {check.target}
                      </div>

                      <p className="text-xs text-foreground/90 bg-black/20 rounded-md p-2">
                        {check.message}
                      </p>

                      {check.recommendation && (
                        <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 p-2.5 text-xs text-warning">
                          <Wrench className="h-4 w-4 shrink-0 mt-0.5" />
                          <div>
                            <strong className="font-semibold">คำแนะนำในการแก้ไข:</strong>{' '}
                            <span>{check.recommendation}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter className="border-t border-white/10 pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDiagnosticsOpen(false)}
            >
              ปิดหน้าต่าง
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => diagnosticsMutation.mutate()}
              disabled={diagnosticsMutation.isPending}
            >
              {diagnosticsMutation.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-1.5 h-4 w-4" />
              )}
              ตรวจเช็กอีกครั้ง
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  )
}
