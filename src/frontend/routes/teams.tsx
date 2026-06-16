import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Cookie,
  Loader2,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Search,
  Smartphone,
  Users,
} from 'lucide-react'
import { lineBotApi, teamsApi } from '../lib/api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Switch } from '../components/ui/switch'
import { ContentSection, FilterPanel, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { ErrorState } from '../components/ui/error-state'
import { SkeletonTable } from '../components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { formatLineChatOptionLabel, getSelectableLineGroupChats, isSelectableLineGroupId } from '../lib/line-groups'
import { formatDateTime } from '../lib/utils'
import type { Team, TeamInput } from '../types'

export const Route = createFileRoute('/teams')({
  component: TeamsComponent,
})

const statusClassName: Record<string, string> = {
  running: 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success',
  paused: 'border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] text-warning',
  stopped: 'border-white/10 bg-white/[0.04] text-muted-foreground',
  misconfigured: 'border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] text-danger',
  session_expired: 'border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] text-danger',
  error: 'border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] text-danger',
}

type TeamFilter = 'all' | 'enabled' | 'running' | 'issues' | 'disabled'

const teamFilters: Array<{ key: TeamFilter; label: string }> = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'enabled', label: 'เปิดใช้งาน' },
  { key: 'running', label: 'กำลังรัน' },
  { key: 'issues', label: 'มีปัญหา' },
  { key: 'disabled', label: 'ปิดอยู่' },
]

const formSelectClassName = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

function TeamsComponent() {
  const [editingTeam, setEditingTeam] = useState<Team | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<TeamFilter>('all')
  const queryClient = useQueryClient()
  const { data: teams = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['teams'],
    queryFn: teamsApi.list,
    staleTime: 60_000,
  })

  const restartAllMutation = useMutation({
    mutationFn: teamsApi.restartAll,
    onSuccess: () => {
      toast.success('restart ทุกทีมแล้ว')
      queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
    onError: (error: Error) => toast.error('restart ทุกทีมไม่สำเร็จ', { description: error.message }),
  })

  if (isLoading) {
    return (
      <PageShell>
        <ContentSection>
          <SkeletonTable rows={5} cols={6} />
        </ContentSection>
      </PageShell>
    )
  }

  const summary = getTeamSummary(teams)
  const normalizedSearch = search.trim().toLowerCase()
  const filteredTeams = teams.filter((team) => {
    const status = getRuntimeStatus(team)
    const hasIssue = status === 'misconfigured' || status === 'session_expired' || status === 'error'
    const matchesFilter =
      filter === 'all'
      || (filter === 'enabled' && team.enabled)
      || (filter === 'running' && status === 'running')
      || (filter === 'issues' && hasIssue)
      || (filter === 'disabled' && !team.enabled)

    if (!matchesFilter) return false
    if (!normalizedSearch) return true

    return [
      team.name,
      String(team.id),
      status,
      team.spxCookiePreview,
      team.spxDeviceIdPreview,
      team.lineGroupIdPreview,
    ].some((value) => value?.toLowerCase().includes(normalizedSearch))
  })

  return (
    <PageShell>
      <PageHeader
        icon={Building2}
        title="จัดการทีม"
        subtitle="แยก SPX cookie, device id, LINE group และ runtime control ของแต่ละทีม"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => restartAllMutation.mutate()} disabled={restartAllMutation.isPending}>
              {restartAllMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Restart all
            </Button>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              เพิ่มทีม
            </Button>
          </div>
        }
      />

      <TeamSummary summary={summary} />

      <FilterPanel className="mb-0 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-10 rounded-[8px] bg-white/[0.03] pl-9"
            placeholder="ค้นหาชื่อทีม, id, credential preview"
            aria-label="ค้นหาทีม"
          />
        </div>
        <div className="flex flex-wrap gap-1 lg:shrink-0 lg:flex-nowrap" role="group" aria-label="ตัวกรองทีม">
          {teamFilters.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={`min-h-10 shrink-0 rounded-[8px] border px-3 text-xs font-semibold transition-colors ${filter === item.key
                ? 'border-primary/25 bg-primary/[0.10] text-primary'
                : 'border-white/[0.06] bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground'
                }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </FilterPanel>

      <ContentSection className="rounded-[8px] bg-card/80 shadow-none" contentClassName="p-4 sm:p-5">
          {isError ? (
            <ErrorState
              title="โหลดข้อมูลทีมไม่สำเร็จ"
              description="ลองกดปุ่มด้านล่างเพื่อลองโหลดอีกครั้ง"
              error={error}
              onRetry={() => refetch()}
            />
          ) : teams.length === 0 ? (
            <div className="rounded-[8px] border border-dashed border-white/10 bg-white/[0.03] py-14 text-center text-muted-foreground">
              <Building2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>ยังไม่มีทีม</p>
            </div>
          ) : filteredTeams.length === 0 ? (
            <div className="rounded-[8px] border border-dashed border-white/10 bg-white/[0.03] py-12 text-center text-muted-foreground">
              <Search className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="text-sm font-medium text-foreground">ไม่พบทีมที่ตรงกับตัวกรอง</p>
              <p className="mt-1 text-xs">ลองล้างคำค้นหาหรือเลือกตัวกรองอื่น</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="hidden data-scroll lg:block">
                <table className="data-table" data-density="compact" style={{ minWidth: '1040px' }}>
                  <colgroup>
                    <col style={{ width: '4.5rem' }} />
                    <col style={{ width: '11.25rem' }} />
                    <col style={{ width: '6.5rem' }} />
                    <col style={{ width: '7.5rem' }} />
                    <col style={{ width: '11.25rem' }} />
                    <col style={{ width: '7.5rem' }} />
                    <col style={{ width: '8.75rem' }} />
                    <col style={{ width: '8.25rem' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>ลำดับ</th>
                      <th>ชื่อทีม</th>
                      <th>สถานะ</th>
                      <th>Runtime</th>
                      <th>SPX credentials</th>
                      <th>LINE group</th>
                      <th>อัปเดตล่าสุด</th>
                      <th>จัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTeams.map((team) => (
                      <tr key={team.id}>
                        <td>
                          <TeamOrder team={team} />
                        </td>
                        <td>
                          <TeamNameCell team={team} />
                        </td>
                        <td>
                          <TeamStatusPill team={team} />
                        </td>
                        <td>
                          <RuntimeBadge team={team} />
                        </td>
                        <td>
                          <div className="grid gap-2 text-xs">
                            <SecretState icon={Cookie} label="Cookie" ok={team.hasSpxCookie} preview={team.spxCookiePreview} />
                            <SecretState icon={Smartphone} label="Device" ok={team.hasSpxDeviceId} preview={team.spxDeviceIdPreview} />
                          </div>
                        </td>
                        <td>
                          <SecretState icon={MessageCircle} label="LINE" ok={team.hasLineGroupId} preview={team.lineGroupIdPreview} />
                        </td>
                        <td className="text-muted-foreground">{formatDateTime(team.updatedAt)}</td>
                        <td>
                          <TeamActions team={team} onEdit={() => setEditingTeam(team)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-3 lg:hidden">
                {filteredTeams.map((team) => (
                  <TeamMobilePanel key={team.id} team={team} onEdit={() => setEditingTeam(team)} />
                ))}
              </div>
            </div>
          )}
      </ContentSection>

      <TeamFormDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      <TeamFormDialog team={editingTeam} open={editingTeam !== null} onOpenChange={(open) => { if (!open) setEditingTeam(null) }} />
    </PageShell>
  )
}

function getRuntimeStatus(team: Team): NonNullable<Team['runtimeStatus']> {
  return team.runtimeStatus || 'stopped'
}

function getTeamSummary(teams: Team[]) {
  return {
    total: teams.length,
    enabled: teams.filter((team) => team.enabled).length,
    running: teams.filter((team) => getRuntimeStatus(team) === 'running').length,
    issues: teams.filter((team) => {
      const status = getRuntimeStatus(team)
      return status === 'misconfigured' || status === 'session_expired' || status === 'error'
    }).length,
  }
}

function TeamSummary({ summary }: { summary: ReturnType<typeof getTeamSummary> }) {
  const items = [
    { label: 'ทีมทั้งหมด', value: summary.total, icon: Building2, tone: 'text-foreground' },
    { label: 'เปิดใช้งาน', value: summary.enabled, icon: CheckCircle2, tone: 'text-success' },
    { label: 'กำลังรัน', value: summary.running, icon: Play, tone: 'text-info' },
    { label: 'ต้องดูแล', value: summary.issues, icon: AlertTriangle, tone: summary.issues > 0 ? 'text-warning' : 'text-muted-foreground' },
  ]

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => {
        const Icon = item.icon
        return (
          <div key={item.label} className="rounded-[8px] border border-white/[0.06] bg-white/[0.025] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
              <Icon className={`h-4 w-4 ${item.tone}`} />
            </div>
            <div className={`mt-2 font-data text-2xl font-semibold leading-none ${item.tone}`}>
              {item.value}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TeamOrder({ team }: { team: Team }) {
  return (
    <span className="font-data text-xs font-semibold text-muted-foreground">
      #{team.id}
    </span>
  )
}

function TeamNameCell({ team }: { team: Team }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate font-semibold text-foreground">{team.name}</span>
      {typeof team.usersCount === 'number' ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          {team.usersCount} users
        </span>
      ) : null}
    </div>
  )
}

function TeamStatusPill({ team }: { team: Team }) {
  return (
    <span className={`status-pill ${team.enabled ? 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success' : 'border-white/10 bg-white/[0.04] text-muted-foreground'}`}>
      {team.enabled ? 'enabled' : 'disabled'}
    </span>
  )
}

function RuntimeBadge({ team }: { team: Team }) {
  const status = getRuntimeStatus(team)
  return (
    <span className={`status-pill ${statusClassName[status] || statusClassName.stopped}`}>
      {status}
    </span>
  )
}

function SecretState({
  icon: Icon,
  label,
  ok,
  preview,
}: {
  icon: typeof Cookie
  label: string
  ok: boolean
  preview: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
      <Icon className={ok ? 'h-3.5 w-3.5 shrink-0 text-success' : 'h-3.5 w-3.5 shrink-0 text-danger'} />
      <span className="shrink-0 font-medium text-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate">{ok ? preview : 'missing'}</span>
    </div>
  )
}

function TeamMobilePanel({ team, onEdit }: { team: Team; onEdit: () => void }) {
  return (
    <article className="min-w-0 max-w-full overflow-hidden rounded-[8px] border border-white/[0.06] bg-white/[0.025] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <TeamOrder team={team} />
          <TeamNameCell team={team} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <TeamStatusPill team={team} />
          <RuntimeBadge team={team} />
        </div>
      </div>

      <div className="mt-4 grid gap-2 rounded-[8px] border border-white/[0.06] bg-black/10 p-3 text-xs">
        <SecretState icon={Cookie} label="Cookie" ok={team.hasSpxCookie} preview={team.spxCookiePreview} />
        <SecretState icon={Smartphone} label="Device" ok={team.hasSpxDeviceId} preview={team.spxDeviceIdPreview} />
        <SecretState icon={MessageCircle} label="LINE" ok={team.hasLineGroupId} preview={team.lineGroupIdPreview} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>อัปเดตล่าสุด</span>
        <span className="text-right">{formatDateTime(team.updatedAt)}</span>
      </div>

      <div className="mt-4">
        <TeamActions team={team} onEdit={onEdit} compact />
      </div>
    </article>
  )
}

function TeamActions({ team, onEdit, compact = false }: { team: Team; onEdit: () => void; compact?: boolean }) {
  const queryClient = useQueryClient()

  const actionMutation = useMutation({
    mutationFn: async (action: 'restart' | 'pause' | 'resume' | 'disable') => {
      if (action === 'restart') return teamsApi.restart(team.id)
      if (action === 'pause') return teamsApi.pause(team.id)
      if (action === 'resume') return teamsApi.resume(team.id)
      return teamsApi.disable(team.id)
    },
    onSuccess: (_result, action) => {
      const labels = { restart: 'restart', pause: 'pause', resume: 'resume', disable: 'disable' }
      toast.success(`${labels[action]} ${team.name} แล้ว`)
      queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
    onError: (error: Error) => toast.error('ดำเนินการไม่สำเร็จ', { description: error.message }),
  })

  const isPaused = team.runtimeStatus === 'paused'
  const actionItems = [
    {
      key: 'edit',
      label: 'แก้ไข',
      title: `แก้ไขทีม ${team.name}`,
      icon: <Pencil className="h-3.5 w-3.5" />,
      onClick: onEdit,
      disabled: false,
      danger: false,
    },
    {
      key: 'restart',
      label: 'Restart',
      title: `Restart ทีม ${team.name}`,
      icon: <RotateCcw className="h-3.5 w-3.5" />,
      onClick: () => actionMutation.mutate('restart'),
      disabled: actionMutation.isPending || !team.enabled,
      danger: false,
    },
    {
      key: isPaused ? 'resume' : 'pause',
      label: isPaused ? 'Resume' : 'Pause',
      title: `${isPaused ? 'Resume' : 'Pause'} ทีม ${team.name}`,
      icon: isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />,
      onClick: () => actionMutation.mutate(isPaused ? 'resume' : 'pause'),
      disabled: actionMutation.isPending || !team.enabled,
      danger: false,
    },
    {
      key: 'disable',
      label: 'Disable',
      title: `Disable ทีม ${team.name}`,
      icon: <PowerOff className="h-3.5 w-3.5" />,
      onClick: () => actionMutation.mutate('disable'),
      disabled: actionMutation.isPending || !team.enabled,
      danger: true,
    },
  ]

  return (
    <div
      className={compact
        ? 'grid grid-cols-4 overflow-hidden rounded-[8px] border border-white/[0.08] bg-white/[0.025]'
        : 'inline-flex overflow-hidden rounded-[8px] border border-white/[0.08] bg-white/[0.025]'}
      aria-label={`จัดการทีม ${team.name}`}
    >
      {actionItems.map((item, index) => (
        <Button
          key={item.key}
          type="button"
          variant="ghost"
          size="icon"
          className={`h-9 w-9 rounded-none border-r border-white/[0.06] px-0 last:border-r-0 ${compact ? 'w-full' : ''} ${item.danger ? 'text-danger hover:text-danger hover:bg-[color:var(--color-danger-soft)]' : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.06]'}`}
          onClick={item.onClick}
          disabled={item.disabled}
          title={item.title}
          aria-label={item.title}
        >
          {actionMutation.isPending && index > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : item.icon}
          <span className="sr-only">{item.label}</span>
        </Button>
      ))}
    </div>
  )
}

function TeamFormDialog({
  team,
  open,
  onOpenChange,
}: {
  team?: Team | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const isEdit = Boolean(team)
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [spxCookie, setSpxCookie] = useState('')
  const [spxDeviceId, setSpxDeviceId] = useState('')
  const [lineGroupId, setLineGroupId] = useState('')

  const lineStatusQuery = useQuery({
    queryKey: ['line-bot-status'],
    queryFn: lineBotApi.status,
    enabled: open,
    staleTime: 30_000,
    retry: false,
  })
  const lineStatus = lineStatusQuery.data
  const canLoadLineGroups = open && lineStatus?.enabled === true && lineStatus.authenticated === true
  const lineGroupsQuery = useQuery({
    queryKey: ['line-bot-groups'],
    queryFn: lineBotApi.getGroups,
    enabled: canLoadLineGroups,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  const lineGroups = getSelectableLineGroupChats(lineGroupsQuery.data?.chats ?? [])
  const selectedLineGroupValue = lineGroups.some((chat) => chat.chatMid === lineGroupId) ? lineGroupId : ''
  const hasSelectableLineGroups = canLoadLineGroups && lineGroups.length > 0

  const reset = useCallback(() => {
    setName(team?.name ?? '')
    setEnabled(team?.enabled ?? true)
    setSpxCookie(team?.spxCookiePreview ?? '')
    setSpxDeviceId(team?.spxDeviceIdPreview ?? '')
    setLineGroupId(team?.lineGroupIdPreview ?? '')
  }, [team?.enabled, team?.lineGroupIdPreview, team?.name, team?.spxCookiePreview, team?.spxDeviceIdPreview])

  useEffect(() => {
    if (open) reset()
  }, [open, reset])

  const mutation = useMutation({
    mutationFn: () => {
      const input: TeamInput = {
        name: name.trim(),
        enabled,
        spxCookie,
        spxDeviceId,
        lineGroupId,
      }
      return team ? teamsApi.update(team.id, input) : teamsApi.create(input)
    },
    onSuccess: () => {
      toast.success(isEdit ? 'บันทึกทีมแล้ว' : 'เพิ่มทีมแล้ว', { description: name.trim() })
      queryClient.invalidateQueries({ queryKey: ['teams'] })
      onOpenChange(false)
    },
    onError: (error: Error) => toast.error(isEdit ? 'บันทึกทีมไม่สำเร็จ' : 'เพิ่มทีมไม่สำเร็จ', { description: error.message }),
  })

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) reset()
    onOpenChange(nextOpen)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim()) {
      toast.error('กรุณากรอกชื่อทีม')
      return
    }
    if (!isEdit && (!spxCookie.trim() || !spxDeviceId.trim())) {
      toast.error('ทีมใหม่ต้องมี Cookie และ Device ID')
      return
    }
    if (!isSelectableLineGroupId(lineGroupId, lineGroups)) {
      toast.error('กรุณาเลือก LINE group จาก dropdown')
      return
    }
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto rounded-[8px] sm:max-w-[640px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? 'แก้ไขทีม' : 'เพิ่มทีมใหม่'}</DialogTitle>
            <DialogDescription>
              ตั้งค่า credential ต่อทีมและปลายทาง LINE สำหรับ notification ของทีมนั้น
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="team-name">ชื่อทีม</Label>
              <Input id="team-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Default Team" autoFocus />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-[8px] border border-white/10 bg-white/[0.03] px-4 py-3">
              <div>
                <Label>เปิดใช้งาน</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">runtime manager จะ start เฉพาะทีมที่ enabled</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="team-cookie">SPX Cookie</Label>
              <textarea
                id="team-cookie"
                value={spxCookie}
                onChange={(event) => setSpxCookie(event.target.value)}
                className="flex min-h-[6rem] w-full resize-y rounded-[8px] border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                placeholder="fms_user_id=...; session=..."
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="team-device">Device ID</Label>
              <Input id="team-device" value={spxDeviceId} onChange={(event) => setSpxDeviceId(event.target.value)} placeholder="device id จาก SPX browser" />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="team-line">LINE Group ID</Label>
              <div className="flex gap-2">
                <select
                  id="team-line"
                  value={selectedLineGroupValue}
                  onChange={(event) => {
                    setLineGroupId(event.target.value)
                  }}
                  disabled={!canLoadLineGroups || lineGroupsQuery.isLoading || !hasSelectableLineGroups}
                  className={formSelectClassName}
                >
                  <option value="">
                    {lineStatusQuery.isLoading
                      ? 'กำลังตรวจสอบ LINE JS...'
                      : !lineStatus?.enabled
                        ? 'LINE JS ยังไม่ได้เปิดใช้งาน'
                        : !lineStatus.authenticated
                          ? 'LINE JS ยังไม่ได้ login'
                          : lineGroupsQuery.isLoading
                            ? 'กำลังโหลดรายชื่อ LINE...'
                            : hasSelectableLineGroups
                              ? 'เลือก LINE group'
                              : 'ไม่พบ LINE group จากบัญชีนี้'}
                  </option>
                  {lineGroups.map((chat) => (
                    <option key={chat.chatMid} value={chat.chatMid}>
                      {formatLineChatOptionLabel(chat)}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => lineGroupsQuery.refetch()}
                  disabled={!canLoadLineGroups || lineGroupsQuery.isFetching}
                  title="Refresh LINE groups"
                  aria-label="Refresh LINE groups"
                >
                  <RefreshCw className={`h-4 w-4 ${lineGroupsQuery.isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              {lineGroupsQuery.isError ? (
                <div className="flex items-center gap-2 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>โหลดรายชื่อ LINE ไม่สำเร็จ กรุณา refresh หรือตรวจสอบ LINE JS</span>
                </div>
              ) : null}
              {!canLoadLineGroups ? (
                <div className="flex items-center gap-2 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>ต้องเปิด LINE JS และ login ก่อน จึงจะเลือก LINE group ได้</span>
                </div>
              ) : null}
              {canLoadLineGroups && !hasSelectableLineGroups ? (
                <div className="flex items-center gap-2 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>บัญชี LINE ที่ login ยังไม่พบ group chat สำหรับเลือก</span>
                </div>
              ) : null}
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => handleOpenChange(false)} disabled={mutation.isPending}>
              ยกเลิก
            </Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={mutation.isPending || !isSelectableLineGroupId(lineGroupId, lineGroups)}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  กำลังบันทึก...
                </>
              ) : (
                'บันทึกทีม'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
