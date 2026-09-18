import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Bell,
  BellOff,
  Building2,
  CheckCircle2,
  Cookie,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Search,
  Smartphone,
  Trash2,
  Truck,
  Users,
  X,
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
import { formatLineChatOptionLabel, getSelectableLineGroupChats, isRedactedSecretPreview, isSelectableLineGroupId } from '../lib/line-groups'
import { formatDateTime } from '../lib/utils'
import type { LineBotChat, Team, TeamInput, TeamSpxAccount } from '../types'
import { ProviderAuthPanel } from '../components/ProviderAuthPanel'

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

export const VEHICLE_TYPE_OPTIONS = [
  { value: '', label: 'ทั้งหมด (ไม่กรอง)' },
  { value: '13', label: '6WH-6ล้อ [7.2m]' },
  { value: '12', label: '6WH-6ล้อ[5.5m]' },
  { value: '8', label: 'Semi trailer-รถพ่วงแม่ลูก' },
  { value: '2', label: '4WH-4ล้อ' },
] as const

const formSelectClassName = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

export function getLineGroupSelectValue(value: string, lineGroups: LineBotChat[]): string {
  if (isRedactedSecretPreview(value)) return value
  return lineGroups.some((chat) => chat.chatMid === value) ? value : ''
}

export function getNextLinkedLineTarget({
  currentTarget,
  previousDefaultTarget,
  nextDefaultTarget,
}: {
  currentTarget: string
  previousDefaultTarget: string
  nextDefaultTarget: string
}): string {
  if (!currentTarget.trim() || currentTarget === previousDefaultTarget) {
    return nextDefaultTarget
  }
  return currentTarget
}

function lineGroupPlaceholder({
  lineStatusLoading,
  lineStatusError,
  lineEnabled,
  lineAuthenticated,
  lineGroupsLoading,
  lineGroupsError,
  hasSelectableLineGroups,
}: {
  lineStatusLoading: boolean
  lineStatusError: boolean
  lineEnabled: boolean
  lineAuthenticated: boolean
  lineGroupsLoading: boolean
  lineGroupsError: boolean
  hasSelectableLineGroups: boolean
}) {
  if (lineStatusLoading) return 'Checking LINE JS...'
  if (lineStatusError) return 'ยังยืนยันสถานะ LINE ไม่ได้'
  if (!lineEnabled) return 'LINE JS is not enabled'
  if (!lineAuthenticated) return 'LINE JS is not logged in'
  if (lineGroupsLoading) return 'Loading LINE groups...'
  if (lineGroupsError) return 'ยังโหลดรายชื่อ LINE group ไม่สำเร็จ'
  return hasSelectableLineGroups ? 'Select LINE group' : 'No LINE groups found for this account'
}

function LineGroupField({
  id,
  label,
  value,
  onChange,
  lineStatusLoading,
  lineStatusError,
  lineEnabled,
  lineAuthenticated,
  lineGroupsLoading,
  lineGroupsError,
  lineGroupsFetching,
  canLoadLineGroups,
  hasSelectableLineGroups,
  lineGroups,
  onRefresh,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  lineStatusLoading: boolean
  lineStatusError: boolean
  lineEnabled: boolean
  lineAuthenticated: boolean
  lineGroupsLoading: boolean
  lineGroupsError: boolean
  lineGroupsFetching: boolean
  canLoadLineGroups: boolean
  hasSelectableLineGroups: boolean
  lineGroups: LineBotChat[]
  onRefresh: () => void
}) {
  const isMaskedCurrent = isRedactedSecretPreview(value)

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <select
          id={id}
          value={getLineGroupSelectValue(value, lineGroups)}
          onChange={(event) => onChange(event.target.value)}
          disabled={!canLoadLineGroups || lineGroupsLoading || !hasSelectableLineGroups}
          className={formSelectClassName}
        >
          {isMaskedCurrent ? (
            <option value={value} disabled>
              Current saved target ({value})
            </option>
          ) : null}
          <option value="">
            {lineGroupPlaceholder({
              lineStatusLoading,
              lineStatusError,
              lineEnabled,
              lineAuthenticated,
              lineGroupsLoading,
              lineGroupsError,
              hasSelectableLineGroups,
            })}
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
          onClick={onRefresh}
          disabled={!canLoadLineGroups || lineGroupsFetching}
          title="Refresh LINE groups"
          aria-label="Refresh LINE groups"
        >
          <RefreshCw className={`h-4 w-4 ${lineGroupsFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>
    </div>
  )
}

function TeamsComponent() {
  const [editingTeam, setEditingTeam] = useState<Team | null>(null)
  const [accountsTeam, setAccountsTeam] = useState<Team | null>(null)
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
      team.autoAcceptSuccessLineGroupIdPreview,
      team.autoAcceptFailureLineGroupIdPreview,
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
            className="h-10 rounded-[8px] bg-white/[0.03] pl-9 pr-9"
            placeholder="ค้นหาชื่อทีม, id, credential preview"
            aria-label="ค้นหาทีม"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="ล้างคำค้นหา"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
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

      <ContentSection>
        {isError ? (
          <ErrorState
            title="โหลดข้อมูลทีมไม่สำเร็จ"
            description="ไม่สามารถดึงข้อมูลทีมจาก server ได้ กรุณาลองใหม่อีกครั้ง"
            error={error}
            onRetry={() => refetch()}
          />
        ) : filteredTeams.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-white/10 p-8 text-center text-sm text-muted-foreground">
            {search ? 'ไม่พบทีมที่ตรงกับคำค้นหา' : 'ยังไม่มีทีมในระบบ'}
          </div>
        ) : (
            <div>
              <div className="hidden lg:block">
                <table className="table-unified">
                  <colgroup>
                    <col style={{ width: '4rem' }} />
                    <col style={{ width: '13.75rem' }} />
                    <col style={{ width: '6.25rem' }} />
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
                            <VehicleTypeState vehicleType={team.biddingVehicleType} />
                            <button
                              type="button"
                              onClick={() => setAccountsTeam(team)}
                              className="mt-0.5 inline-flex items-center gap-1.5 rounded-[6px] border border-white/10 bg-white/[0.04] px-2 py-1 text-left text-xs font-medium text-primary hover:border-primary/40 hover:bg-primary/[0.08] transition-colors"
                              title={`จัดการบัญชี SPX หมุนเวียน ${team.name}`}
                            >
                              <Users className="h-3 w-3 shrink-0" />
                              <span>บัญชีหมุนเวียน (Multi-Account)</span>
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="grid gap-2 text-xs">
                            <SecretState icon={MessageCircle} label="LINE" ok={team.hasLineGroupId} preview={team.lineGroupIdPreview} />
                            <SecretState icon={MessageCircle} label="Auto OK" ok={team.hasAutoAcceptSuccessLineGroupId} preview={team.autoAcceptSuccessLineGroupIdPreview} />
                            <SecretState icon={MessageCircle} label="Auto Fail" ok={team.hasAutoAcceptFailureLineGroupId} preview={team.autoAcceptFailureLineGroupIdPreview} />
                            <RateLimitState enabled={team.rateLimitNotifyEnabled} />
                          </div>
                        </td>
                        <td className="text-muted-foreground">{formatDateTime(team.updatedAt)}</td>
                        <td>
                          <TeamActions
                            team={team}
                            onEdit={() => setEditingTeam(team)}
                            onManageAccounts={() => setAccountsTeam(team)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-3 lg:hidden">
                {filteredTeams.map((team) => (
                  <TeamMobilePanel
                    key={team.id}
                    team={team}
                    onEdit={() => setEditingTeam(team)}
                    onManageAccounts={() => setAccountsTeam(team)}
                  />
                ))}
              </div>
            </div>
          )}
      </ContentSection>

      <TeamFormDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={(team) => setEditingTeam(team)}
      />
      <TeamFormDialog
        team={editingTeam}
        open={editingTeam !== null}
        onOpenChange={(open) => { if (!open) setEditingTeam(null) }}
        onManageAccounts={(team) => {
          setEditingTeam(null)
          setAccountsTeam(team)
        }}
      />
      <TeamSpxAccountsDialog
        team={accountsTeam}
        open={accountsTeam !== null}
        onOpenChange={(open) => { if (!open) setAccountsTeam(null) }}
      />
    </PageShell>
  )
}

function getRuntimeStatus(team: Pick<Team, 'runtimeStatus'>): NonNullable<Team['runtimeStatus']> {
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

function RateLimitState({ enabled }: { enabled?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
      {enabled ? (
        <Bell className="h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <BellOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      )}
      <span className="shrink-0 font-medium text-foreground">Rate Limit</span>
      <span className={`min-w-0 flex-1 truncate ${enabled ? 'text-success font-medium' : 'text-muted-foreground/70'}`}>
        {enabled ? 'เปิดแจ้งเตือน' : 'ปิด'}
      </span>
    </div>
  )
}

function getVehicleTypeLabel(vehicleType?: number | null): string {
  const option = VEHICLE_TYPE_OPTIONS.find((item) => item.value === String(vehicleType ?? ''))
  if (option) return option.label
  if (typeof vehicleType === 'number') return `Type ${vehicleType}`
  return 'ทั้งหมด (ไม่กรอง)'
}

function VehicleTypeState({ vehicleType }: { vehicleType?: number | null }) {
  const label = getVehicleTypeLabel(vehicleType)
  const isFiltered = typeof vehicleType === 'number'
  return (
    <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
      <Truck className={`h-3.5 w-3.5 shrink-0 ${isFiltered ? 'text-primary' : 'text-muted-foreground/60'}`} />
      <span className="shrink-0 font-medium text-foreground">รถ ADHOC</span>
      <span className={`min-w-0 flex-1 truncate ${isFiltered ? 'text-primary font-medium' : 'text-muted-foreground/70'}`}>
        {label}
      </span>
    </div>
  )
}


function TeamMobilePanel({
  team,
  onEdit,
  onManageAccounts,
}: {
  team: Team
  onEdit: () => void
  onManageAccounts: () => void
}) {
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
        <VehicleTypeState vehicleType={team.biddingVehicleType} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1 w-full h-8 text-xs flex items-center justify-center gap-1.5 border-white/10 hover:border-primary/40 text-primary hover:bg-primary/[0.08]"
          onClick={onManageAccounts}
        >
          <Users className="h-3.5 w-3.5 shrink-0" />
          <span>จัดการบัญชีหมุนเวียน (Multi-Account)</span>
        </Button>
        <SecretState icon={MessageCircle} label="LINE" ok={team.hasLineGroupId} preview={team.lineGroupIdPreview} />
        <SecretState icon={MessageCircle} label="Auto OK" ok={team.hasAutoAcceptSuccessLineGroupId} preview={team.autoAcceptSuccessLineGroupIdPreview} />
        <SecretState icon={MessageCircle} label="Auto Fail" ok={team.hasAutoAcceptFailureLineGroupId} preview={team.autoAcceptFailureLineGroupIdPreview} />
        <RateLimitState enabled={team.rateLimitNotifyEnabled} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>อัปเดตล่าสุด</span>
        <span className="text-right">{formatDateTime(team.updatedAt)}</span>
      </div>

      <div className="mt-4">
        <TeamActions team={team} onEdit={onEdit} onManageAccounts={onManageAccounts} compact />
      </div>
    </article>
  )
}

type TeamActionCommand = 'restart' | 'pause' | 'resume' | 'disable' | 'enable'

export function getTeamEnableToggleAction(team: Pick<Team, 'enabled' | 'name'>) {
  const isEnabled = team.enabled

  return {
    command: isEnabled ? 'disable' : 'enable',
    label: isEnabled ? 'Disable' : 'Enable',
    title: `${isEnabled ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}ทีม ${team.name}`,
    danger: isEnabled,
  } as const
}

export function getTeamRuntimeToggleAction(team: Pick<Team, 'enabled' | 'name' | 'runtimeStatus'>) {
  const status = getRuntimeStatus(team)
  const isPaused = status === 'paused'
  const canToggle = status === 'running' || isPaused
  const command = isPaused ? 'resume' : 'pause'
  const label = isPaused ? 'Resume' : 'Pause'

  return {
    command,
    label,
    title: `${label} ทีม ${team.name}`,
    disabled: !team.enabled || !canToggle,
  } as const
}

function TeamActions({
  team,
  onEdit,
  onManageAccounts,
  compact = false,
}: {
  team: Team
  onEdit: () => void
  onManageAccounts?: () => void
  compact?: boolean
}) {
  const queryClient = useQueryClient()

  const actionMutation = useMutation({
    mutationFn: async (action: TeamActionCommand) => {
      if (action === 'restart') return teamsApi.restart(team.id)
      if (action === 'pause') return teamsApi.pause(team.id)
      if (action === 'resume') return teamsApi.resume(team.id)
      return teamsApi.update(team.id, { enabled: action === 'enable' })
    },
    onSuccess: (_result, action) => {
      const labels: Record<TeamActionCommand, string> = {
        restart: 'restart',
        pause: 'pause',
        resume: 'resume',
        disable: 'ปิดใช้งาน',
        enable: 'เปิดใช้งาน',
      }
      toast.success(`${labels[action]} ${team.name} แล้ว`)
      queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
    onError: (error: Error) => toast.error('ดำเนินการไม่สำเร็จ', { description: error.message }),
  })

  const enableToggleAction = getTeamEnableToggleAction(team)
  const runtimeToggleAction = getTeamRuntimeToggleAction(team)
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
    ...(onManageAccounts
      ? [
          {
            key: 'accounts',
            label: 'บัญชี SPX',
            title: `จัดการบัญชี SPX หมุนเวียน ${team.name}`,
            icon: <Users className="h-3.5 w-3.5 text-primary" />,
            onClick: onManageAccounts,
            disabled: false,
            danger: false,
          },
        ]
      : []),
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
      key: runtimeToggleAction.command,
      label: runtimeToggleAction.label,
      title: runtimeToggleAction.title,
      icon: runtimeToggleAction.command === 'resume' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />,
      onClick: () => actionMutation.mutate(runtimeToggleAction.command),
      disabled: actionMutation.isPending || runtimeToggleAction.disabled,
      danger: false,
    },
    {
      key: enableToggleAction.command,
      label: enableToggleAction.label,
      title: enableToggleAction.title,
      icon: enableToggleAction.command === 'enable' ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />,
      onClick: () => actionMutation.mutate(enableToggleAction.command),
      disabled: actionMutation.isPending,
      danger: enableToggleAction.danger,
      success: !enableToggleAction.danger,
    },
  ]

  return (
    <div
      className={compact
        ? `grid ${onManageAccounts ? 'grid-cols-5' : 'grid-cols-4'} overflow-hidden rounded-[8px] border border-white/[0.08] bg-white/[0.025]`
        : 'inline-flex overflow-hidden rounded-[8px] border border-white/[0.08] bg-white/[0.025]'}
      aria-label={`จัดการทีม ${team.name}`}
    >
      {actionItems.map((item, index) => (
        <Button
          key={item.key}
          type="button"
          variant="ghost"
          size="icon"
          className={`h-9 w-9 rounded-none border-r border-white/[0.06] px-0 last:border-r-0 ${compact ? 'w-full' : ''} ${item.danger
            ? 'text-danger hover:text-danger hover:bg-[color:var(--color-danger-soft)]'
            : item.success
              ? 'text-success hover:text-success hover:bg-[color:var(--color-success-soft)]'
              : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.06]'
            }`}
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
  onCreated,
  onManageAccounts,
}: {
  team?: Team | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (team: Team) => void
  onManageAccounts?: (team: Team) => void
}) {
  const queryClient = useQueryClient()
  const isEdit = Boolean(team)
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [spxCookie, setSpxCookie] = useState('')
  const [spxDeviceId, setSpxDeviceId] = useState('')
  const [lineGroupId, setLineGroupId] = useState('')
  const [autoAcceptSuccessLineGroupId, setAutoAcceptSuccessLineGroupId] = useState('')
  const [autoAcceptFailureLineGroupId, setAutoAcceptFailureLineGroupId] = useState('')
  const [rateLimitNotifyEnabled, setRateLimitNotifyEnabled] = useState(false)
  const [biddingVehicleType, setBiddingVehicleType] = useState<number | null>(null)

  const lineStatusQuery = useQuery({
    queryKey: ['line-bot-status'],
    queryFn: lineBotApi.status,
    enabled: open,
    staleTime: 30_000,
    retry: false,
  })
  const lineStatus = lineStatusQuery.data
  const canLoadLineGroups = open && lineStatusQuery.isSuccess && lineStatus?.enabled === true && lineStatus.authenticated === true
  const lineGroupsQuery = useQuery({
    queryKey: ['line-bot-groups'],
    queryFn: lineBotApi.getGroups,
    enabled: canLoadLineGroups,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  const lineGroups = getSelectableLineGroupChats(lineGroupsQuery.data?.chats ?? [])
  const hasSelectableLineGroups = canLoadLineGroups && lineGroupsQuery.isSuccess && lineGroups.length > 0
  const isLineGroupValueValid = useCallback((value: string) => (
    isRedactedSecretPreview(value) || (canLoadLineGroups && lineGroupsQuery.isSuccess && isSelectableLineGroupId(value, lineGroups))
  ), [canLoadLineGroups, lineGroupsQuery.isSuccess, lineGroups])
  const areLineTargetsValid =
    isLineGroupValueValid(lineGroupId)
    && isLineGroupValueValid(autoAcceptSuccessLineGroupId)
    && isLineGroupValueValid(autoAcceptFailureLineGroupId)

  const handleDefaultLineGroupChange = useCallback((value: string) => {
    setAutoAcceptSuccessLineGroupId((currentTarget) => getNextLinkedLineTarget({
      currentTarget,
      previousDefaultTarget: lineGroupId,
      nextDefaultTarget: value,
    }))
    setAutoAcceptFailureLineGroupId((currentTarget) => getNextLinkedLineTarget({
      currentTarget,
      previousDefaultTarget: lineGroupId,
      nextDefaultTarget: value,
    }))
    setLineGroupId(value)
  }, [lineGroupId])

  const reset = useCallback(() => {
    setName(team?.name ?? '')
    setEnabled(team?.enabled ?? true)
    setSpxCookie(team?.spxCookiePreview ?? '')
    setSpxDeviceId(team?.spxDeviceIdPreview ?? '')
    setLineGroupId(team?.lineGroupIdPreview ?? '')
    setAutoAcceptSuccessLineGroupId(team?.autoAcceptSuccessLineGroupIdPreview ?? '')
    setAutoAcceptFailureLineGroupId(team?.autoAcceptFailureLineGroupIdPreview ?? '')
    setRateLimitNotifyEnabled(team?.rateLimitNotifyEnabled ?? false)
    setBiddingVehicleType(team?.biddingVehicleType ?? null)
  }, [
    team?.autoAcceptFailureLineGroupIdPreview,
    team?.autoAcceptSuccessLineGroupIdPreview,
    team?.biddingVehicleType,
    team?.enabled,
    team?.lineGroupIdPreview,
    team?.name,
    team?.rateLimitNotifyEnabled,
    team?.spxCookiePreview,
    team?.spxDeviceIdPreview,
  ])

  useEffect(() => {
    if (open) reset()
  }, [open, reset])

  const mutation = useMutation({
    mutationFn: () => {
      const input: TeamInput = {
        name: name.trim(),
        enabled,
        // The provider panel (or another operator) can replace this session while
        // the settings snapshot is open. Only explicit legacy edits override it.
        ...(!team || spxCookie !== (team.spxCookiePreview ?? '') ? { spxCookie } : {}),
        ...(!team || spxDeviceId !== (team.spxDeviceIdPreview ?? '') ? { spxDeviceId } : {}),
        lineGroupId,
        autoAcceptSuccessLineGroupId,
        autoAcceptFailureLineGroupId,
        rateLimitNotifyEnabled,
        biddingVehicleType,
      }
      return team ? teamsApi.update(team.id, input) : teamsApi.create(input)
    },
    onSuccess: (savedTeam) => {
      toast.success(isEdit ? 'บันทึกทีมแล้ว' : 'เพิ่มทีมแล้ว', { description: name.trim() })
      queryClient.invalidateQueries({ queryKey: ['teams'] })
      if (!isEdit) onCreated?.(savedTeam)
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
    if (!isLineGroupValueValid(lineGroupId)) {
      toast.error('กรุณาเลือก LINE group จาก dropdown')
      return
    }
    if (!isLineGroupValueValid(autoAcceptSuccessLineGroupId) || !isLineGroupValueValid(autoAcceptFailureLineGroupId)) {
      toast.error('Please select LINE groups for auto-accept notifications')
      return
    }
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent closeLabel="ปิดหน้าต่าง" className="max-h-[90dvh] overflow-y-auto rounded-[8px] sm:max-w-[640px]">
        <form onSubmit={handleSubmit} noValidate>
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

            <div className="flex items-center justify-between gap-4 rounded-[8px] border border-white/10 bg-white/[0.03] px-4 py-3">
              <div>
                <Label>แจ้งเตือน Rate Limit ทาง LINE</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">ส่งการแจ้งเตือนเข้ากลุ่ม LINE เมื่อติด Rate Limit หรือเมื่อคลาย Rate Limit</p>
              </div>
              <Switch checked={rateLimitNotifyEnabled} onCheckedChange={setRateLimitNotifyEnabled} />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="team-vehicle-type">ประเภทรถ ADHOC (Vehicle Type)</Label>
              <select
                id="team-vehicle-type"
                value={biddingVehicleType ?? ''}
                onChange={(event) => {
                  const val = event.target.value
                  setBiddingVehicleType(val === '' ? null : Number(val))
                }}
                className={formSelectClassName}
              >
                {VEHICLE_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">กำหนดโดย Admin — ควบคุมว่า poller ของทีมนี้จะดึงเฉพาะ ADHOC ประเภทรถไหน</p>
            </div>

            {team ? (
              <div className="flex items-center justify-between gap-4 rounded-[8px] border border-primary/25 bg-primary/[0.05] p-3">
                <div>
                  <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Users className="h-4 w-4 text-primary" />
                    <span>บัญชี SPX หมุนเวียน (Multi-Account)</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    สลับหมุนเวียนหลายบัญชีในทีมเดียวกัน ป้องกัน Rate Limit และแย่งงานได้เร็วกว่า
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 border-primary/30 text-primary hover:bg-primary/10"
                  onClick={() => onManageAccounts?.(team)}
                >
                  จัดการบัญชี
                </Button>
              </div>
            ) : null}

            <details className="rounded-[8px] border border-white/10 bg-white/[0.02] p-3">
              <summary className="cursor-pointer text-sm font-medium text-foreground">การเชื่อมต่อแบบเดิม (ขั้นสูง)</summary>
              <p className="mt-1 text-xs text-muted-foreground">ใช้ Cookie และ Device ID เดิมเมื่อจำเป็นเท่านั้น การเชื่อมต่อด้วยบัญชีอยู่ด้านล่างหลังบันทึกทีม</p>
              <div className="mt-3 grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="team-cookie">SPX Cookie</Label>
                  <textarea
                    id="team-cookie"
                    value={spxCookie}
                    onChange={(event) => setSpxCookie(event.target.value)}
                    className="flex min-h-[6rem] w-full resize-none rounded-[8px] border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    placeholder="fms_user_id=...; session=..."
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="team-device">Device ID</Label>
                  <Input id="team-device" value={spxDeviceId} onChange={(event) => setSpxDeviceId(event.target.value)} placeholder="device id จาก SPX browser" />
                </div>
              </div>
            </details>

            <div className="grid gap-2">
              <LineGroupField
                id="team-line"
                label="LINE Group ID"
                value={lineGroupId}
                onChange={handleDefaultLineGroupChange}
                lineStatusLoading={lineStatusQuery.isLoading}
                lineStatusError={lineStatusQuery.isError}
                lineEnabled={lineStatus?.enabled === true}
                lineAuthenticated={lineStatus?.authenticated === true}
                lineGroupsLoading={lineGroupsQuery.isLoading}
                lineGroupsError={lineGroupsQuery.isError}
                lineGroupsFetching={lineGroupsQuery.isFetching}
                canLoadLineGroups={canLoadLineGroups}
                hasSelectableLineGroups={hasSelectableLineGroups}
                lineGroups={lineGroups}
                onRefresh={() => lineGroupsQuery.refetch()}
              />
              <LineGroupField
                id="team-auto-accept-success-line"
                label="Auto-accept success LINE Group ID"
                value={autoAcceptSuccessLineGroupId}
                onChange={setAutoAcceptSuccessLineGroupId}
                lineStatusLoading={lineStatusQuery.isLoading}
                lineStatusError={lineStatusQuery.isError}
                lineEnabled={lineStatus?.enabled === true}
                lineAuthenticated={lineStatus?.authenticated === true}
                lineGroupsLoading={lineGroupsQuery.isLoading}
                lineGroupsError={lineGroupsQuery.isError}
                lineGroupsFetching={lineGroupsQuery.isFetching}
                canLoadLineGroups={canLoadLineGroups}
                hasSelectableLineGroups={hasSelectableLineGroups}
                lineGroups={lineGroups}
                onRefresh={() => lineGroupsQuery.refetch()}
              />
              <LineGroupField
                id="team-auto-accept-failure-line"
                label="Auto-accept failure LINE Group ID"
                value={autoAcceptFailureLineGroupId}
                onChange={setAutoAcceptFailureLineGroupId}
                lineStatusLoading={lineStatusQuery.isLoading}
                lineStatusError={lineStatusQuery.isError}
                lineEnabled={lineStatus?.enabled === true}
                lineAuthenticated={lineStatus?.authenticated === true}
                lineGroupsLoading={lineGroupsQuery.isLoading}
                lineGroupsError={lineGroupsQuery.isError}
                lineGroupsFetching={lineGroupsQuery.isFetching}
                canLoadLineGroups={canLoadLineGroups}
                hasSelectableLineGroups={hasSelectableLineGroups}
                lineGroups={lineGroups}
                onRefresh={() => lineGroupsQuery.refetch()}
              />
              {lineStatusQuery.isError ? (
                <ErrorState
                  title="โหลดสถานะ LINE ไม่สำเร็จ"
                  description="ยังยืนยันการเชื่อมต่อ LINE ไม่ได้ ข้อมูลที่กำลังแก้ไขยังอยู่ กรุณาลองโหลดสถานะอีกครั้ง"
                  error={lineStatusQuery.error}
                  onRetry={() => lineStatusQuery.refetch()}
                />
              ) : null}
              {canLoadLineGroups && lineGroupsQuery.isError ? (
                <ErrorState
                  title="โหลดรายชื่อ LINE group ไม่สำเร็จ"
                  description="ยังเปลี่ยนปลายทาง LINE ไม่ได้ กรุณาลองโหลดรายชื่อกลุ่มอีกครั้ง"
                  error={lineGroupsQuery.error}
                  onRetry={() => lineGroupsQuery.refetch()}
                />
              ) : null}
              {lineStatusQuery.isSuccess && !canLoadLineGroups ? (
                <div className="flex items-center gap-2 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>ต้องเปิด LINE JS และ login ก่อน จึงจะเลือก LINE group ได้</span>
                </div>
              ) : null}
              {canLoadLineGroups && lineGroupsQuery.isSuccess && !hasSelectableLineGroups ? (
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
            <Button type="submit" className="w-full sm:w-auto" disabled={mutation.isPending || !areLineTargetsValid}>
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
        {team ? <ProviderAuthPanel teamId={team.id} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function TeamSpxAccountsDialog({
  team,
  open,
  onOpenChange,
}: {
  team?: Team | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingAccount, setEditingAccount] = useState<TeamSpxAccount | null>(null)

  // Form states (Email + Password only)
  const [formEmail, setFormEmail] = useState('')
  const [formPassword, setFormPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [formName, setFormName] = useState('')
  const [formEnabled, setFormEnabled] = useState(true)

  const accountsQuery = useQuery({
    queryKey: ['team-spx-accounts', team?.id],
    queryFn: () => (team?.id ? teamsApi.listAccounts(team.id) : Promise.resolve([])),
    enabled: open && Boolean(team?.id),
    refetchInterval: open ? 5000 : false,
  })

  const accounts = accountsQuery.data ?? []

  const resetForm = useCallback(() => {
    setFormEmail('')
    setFormPassword('')
    setShowPassword(false)
    setFormName('')
    setFormEnabled(true)
    setShowAddForm(false)
    setEditingAccount(null)
  }, [])

  useEffect(() => {
    if (!open) resetForm()
  }, [open, resetForm])

  const startEdit = (acc: TeamSpxAccount) => {
    setShowAddForm(false)
    setEditingAccount(acc)
    setFormName(acc.name)
    setFormEmail(acc.name.includes('@') ? acc.name : '')
    setFormPassword('')
    setShowPassword(false)
    setFormEnabled(acc.enabled)
  }

  const startAdd = () => {
    resetForm()
    setShowAddForm(true)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!team?.id) return
      if (editingAccount) {
        return teamsApi.updateAccount(team.id, editingAccount.id, {
          name: formName.trim() || formEmail.trim() || undefined,
          email: formEmail.trim() || undefined,
          password: formPassword || undefined,
          enabled: formEnabled,
        })
      }
      return teamsApi.createAccount(team.id, {
        name: formName.trim() || formEmail.trim() || undefined,
        email: formEmail.trim(),
        password: formPassword,
        enabled: formEnabled,
      })
    },
    onSuccess: () => {
      toast.success(editingAccount ? 'บันทึกการแก้ไขบัญชีแล้ว' : 'เข้าสู่ระบบและเพิ่มบัญชี SPX สำเร็จ')
      resetForm()
      queryClient.invalidateQueries({ queryKey: ['team-spx-accounts', team?.id] })
      queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
    onError: (err: Error) => toast.error(editingAccount ? 'บันทึกบัญชีไม่สำเร็จ' : 'เข้าสู่ระบบ SPX ไม่สำเร็จ', { description: err.message }),
  })

  const toggleMutation = useMutation({
    mutationFn: async ({ accountId, enabled }: { accountId: number; enabled: boolean }) => {
      if (!team?.id) return
      return teamsApi.updateAccount(team.id, accountId, { enabled })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-spx-accounts', team?.id] })
      queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
    onError: (err: Error) => toast.error('เปลี่ยนสถานะไม่สำเร็จ', { description: err.message }),
  })

  const deleteMutation = useMutation({
    mutationFn: async (accountId: number) => {
      if (!team?.id) return
      return teamsApi.deleteAccount(team.id, accountId)
    },
    onSuccess: () => {
      toast.success('ลบบัญชีแล้ว')
      queryClient.invalidateQueries({ queryKey: ['team-spx-accounts', team?.id] })
      queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
    onError: (err: Error) => toast.error('ลบบัญชีไม่สำเร็จ', { description: err.message }),
  })

  const resetRateLimitMutation = useMutation({
    mutationFn: async (accountId: number) => {
      if (!team?.id) return
      return teamsApi.resetAccountRateLimit(team.id, accountId)
    },
    onSuccess: () => {
      toast.success('ปลด Rate Limit ของบัญชีแล้ว')
      queryClient.invalidateQueries({ queryKey: ['team-spx-accounts', team?.id] })
    },
    onError: (err: Error) => toast.error('ปลด Rate Limit ไม่สำเร็จ', { description: err.message }),
  })

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!editingAccount) {
      if (!formEmail.trim()) {
        toast.error('กรุณากรอกอีเมล SPX')
        return
      }
      if (!formPassword) {
        toast.error('กรุณากรอกรหัสผ่าน SPX')
        return
      }
    } else {
      if (!formName.trim() && !formEmail.trim()) {
        toast.error('กรุณากรอกชื่อหรืออีเมลบัญชี')
        return
      }
    }
    saveMutation.mutate()
  }

  const enabledCount = accounts.filter((a) => a.enabled).length

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) resetForm(); onOpenChange(next) }}>
      <DialogContent closeLabel="ปิดหน้าต่าง" className="max-h-[90dvh] overflow-y-auto rounded-[8px] sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            <span>บัญชี SPX หมุนเวียน (Multi-Account) — {team?.name}</span>
          </DialogTitle>
          <DialogDescription>
            หมุนเวียนหลายบัญชีในทีมเพื่อแย่งงานได้เร็วกว่า และกระจายโหลดป้องกัน Rate Limit
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Status header banner */}
          <div className="rounded-[8px] border border-white/10 bg-white/[0.02] p-3 text-xs space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  สถานะหมุนเวียน:
                </span>
                <span className="status-pill border-white/10 bg-white/[0.04] text-muted-foreground">
                  {accounts.length === 0
                    ? 'ใช้ Cookie หลักของทีม'
                    : `หมุนเวียน ${enabledCount}/${accounts.length} บัญชี`}
                </span>
              </div>
              {!showAddForm && !editingAccount ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={startAdd}
                  className="h-7 text-xs flex items-center gap-1"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>เพิ่มบัญชี</span>
                </Button>
              ) : null}
            </div>
            <p className="text-muted-foreground text-[11px]">
              ทุกการยิงงาน (Polling หาเที่ยววิ่ง, ดึงรายละเอียด, และกดยืนยันรับงาน) จะหมุนเวียน Round-Robin อัตโนมัติในบัญชีของทีมนี้ หากบัญชีใดติด Rate Limit ระบบจะข้ามไปใช้บัญชีถัดไปทันที
            </p>
          </div>

          {/* Add / Edit Form */}
          {(showAddForm || editingAccount) ? (
            <form onSubmit={handleFormSubmit} className="rounded-[8px] border border-primary/30 bg-white/[0.02] p-4 grid gap-3">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                  <Lock className="h-4 w-4 text-primary" />
                  {editingAccount ? `แก้ไขบัญชี: ${editingAccount.name}` : 'เพิ่มบัญชี SPX ใหม่ (ล็อกอินอัตโนมัติ)'}
                </h4>
                <Button type="button" variant="ghost" size="sm" onClick={resetForm} className="h-6 w-6 p-0" disabled={saveMutation.isPending}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-1">
                  <Label htmlFor="acc-email" className="text-xs">อีเมล SPX (Email) *</Label>
                  <Input
                    id="acc-email"
                    type="email"
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                    placeholder="driver@gmail.com"
                    className="h-8 text-xs"
                    autoFocus
                    disabled={saveMutation.isPending}
                    required={!editingAccount}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="acc-password" className="text-xs">
                    {editingAccount ? 'รหัสผ่านใหม่ (เว้นว่างหากไม่เปลี่ยน)' : 'รหัสผ่าน SPX (Password) *'}
                  </Label>
                  <div className="relative">
                    <Input
                      id="acc-password"
                      type={showPassword ? 'text' : 'password'}
                      value={formPassword}
                      onChange={(e) => setFormPassword(e.target.value)}
                      placeholder="••••••••"
                      className="h-8 text-xs pr-8"
                      disabled={saveMutation.isPending}
                      required={!editingAccount}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid gap-1">
                <Label htmlFor="acc-name" className="text-xs">
                  ชื่อเรียกบัญชี (ไม่บังคับ - เว้นว่างเพื่อใช้อีเมลเป็นชื่อ)
                </Label>
                <Input
                  id="acc-name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={formEmail ? formEmail : 'เช่น คนขับ 1 หรือ SPX-B'}
                  className="h-8 text-xs"
                  disabled={saveMutation.isPending}
                />
              </div>

              <div className="flex items-center justify-between rounded-[6px] border border-white/10 bg-white/[0.02] px-3 py-2">
                <span className="text-xs font-medium text-foreground">เปิดใช้งานบัญชีนี้ในรอบหมุนเวียน</span>
                <Switch checked={formEnabled} onCheckedChange={setFormEnabled} disabled={saveMutation.isPending} />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" size="sm" onClick={resetForm} disabled={saveMutation.isPending}>
                  ยกเลิก
                </Button>
                <Button type="submit" size="sm" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                      กำลังเข้าสู่ระบบ SPX...
                    </>
                  ) : (
                    editingAccount ? 'บันทึกการแก้ไข' : 'เข้าสู่ระบบและเพิ่มบัญชี'
                  )}
                </Button>
              </div>
            </form>
          ) : null}

          {/* Accounts list */}
          {accountsQuery.isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : accounts.length === 0 ? (
            <div className="rounded-[8px] border border-dashed border-white/10 p-6 text-center text-xs text-muted-foreground">
              <Cookie className="mx-auto h-8 w-8 opacity-40 mb-2" />
              <p className="font-medium text-foreground">ยังไม่มีบัญชี SPX ในระบบหมุนเวียน</p>
              <p className="mt-1">กด &quot;เพิ่มบัญชี&quot; เพื่อใส่อีเมลและรหัสผ่าน SPX ของคนขับแต่ละคนในทีม</p>
            </div>
          ) : (
            <div className="grid gap-2">
              {accounts.map((acc) => {
                const isRateLimited = Boolean(acc.isRateLimited)
                const isExpired = Boolean(acc.isSessionExpired)
                const remainingCooldown = acc.rateLimitedUntil
                  ? Math.max(0, Math.ceil((acc.rateLimitedUntil - Date.now()) / 1000))
                  : 0

                return (
                  <div
                    key={acc.id}
                    className={`rounded-[8px] border p-3 transition-colors ${
                      !acc.enabled
                        ? 'border-white/[0.06] bg-white/[0.01] opacity-70'
                        : isRateLimited
                          ? 'border-amber-500/30 bg-amber-500/[0.03]'
                          : isExpired
                            ? 'border-rose-500/30 bg-rose-500/[0.03]'
                            : 'border-white/10 bg-white/[0.025]'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm text-foreground">{acc.name}</span>
                          <span
                            className={`status-pill ${
                              acc.enabled
                                ? 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success'
                                : 'border-white/10 bg-white/[0.04] text-muted-foreground'
                            }`}
                          >
                            {acc.enabled ? 'เปิดใช้งาน' : 'ปิดอยู่'}
                          </span>
                          {isRateLimited ? (
                            <span className="status-pill border-amber-500/30 bg-amber-500/10 text-amber-400 flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              ติด Rate Limit {remainingCooldown > 0 ? `(${remainingCooldown}s)` : ''}
                            </span>
                          ) : null}
                          {isExpired ? (
                            <span className="status-pill border-rose-500/30 bg-rose-500/10 text-rose-400">
                              Cookie หมดอายุ
                            </span>
                          ) : null}
                        </div>

                        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <div className="truncate">
                            <span className="text-muted-foreground/70">Cookie: </span>
                            <span className="font-mono text-foreground">{acc.spxCookiePreview}</span>
                          </div>
                          <div className="truncate">
                            <span className="text-muted-foreground/70">Device: </span>
                            <span className="font-mono text-foreground">{acc.spxDeviceIdPreview}</span>
                          </div>
                          {acc.spxAppName ? (
                            <div className="truncate">
                              <span className="text-muted-foreground/70">App: </span>
                              <span>{acc.spxAppName}</span>
                            </div>
                          ) : null}
                          <div className="truncate">
                            <span className="text-muted-foreground/70">อัปเดต: </span>
                            <span>{formatDateTime(acc.updatedAt)}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 self-start">
                        {isRateLimited ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                            onClick={() => resetRateLimitMutation.mutate(acc.id)}
                            disabled={resetRateLimitMutation.isPending}
                            title="ปลดสถานะ Rate Limit เพื่อให้กลับมาหมุนเวียนทันที"
                          >
                            <RotateCcw className="h-3 w-3 mr-1" />
                            ปลด Limit
                          </Button>
                        ) : null}

                        <Switch
                          checked={acc.enabled}
                          onCheckedChange={() => toggleMutation.mutate({ accountId: acc.id, enabled: !acc.enabled })}
                          disabled={toggleMutation.isPending}
                        />

                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => startEdit(acc)}
                          title="แก้ไขบัญชี"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>

                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-danger hover:text-danger hover:bg-[color:var(--color-danger-soft)]"
                          onClick={() => {
                            if (window.confirm(`ต้องการลบบัญชี ${acc.name} ออกจากระบบหมุนเวียนหรือไม่?`)) {
                              deleteMutation.mutate(acc.id)
                            }
                          }}
                          disabled={deleteMutation.isPending}
                          title="ลบบัญชี"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            ปิด
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
