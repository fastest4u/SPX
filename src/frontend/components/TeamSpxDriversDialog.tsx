import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Search,
  Truck,
  Users,
  X,
} from 'lucide-react'
import { currentTeamApi, teamsApi } from '../lib/api'
import { formatDateTime } from '../lib/utils'
import type { TeamSpxDriver, TeamSpxDriversResponse } from '../types'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

const PAGE_SIZE = 50

export interface TeamSpxDriversDialogProps {
  teamId?: number | null
  teamName?: string
  ownTeam?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}

function buildDriversQueryKey(ownTeam: boolean, teamId?: number | null) {
  return ownTeam ? ['own-team-spx-drivers'] : ['team-spx-drivers', teamId]
}

export function TeamSpxDriversDialog({
  teamId,
  teamName,
  ownTeam = false,
  open,
  onOpenChange,
}: TeamSpxDriversDialogProps) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [vehicleTypeFilter, setVehicleTypeFilter] = useState<number | 'all'>('all')
  const [page, setPage] = useState(1)

  const queryKey = buildDriversQueryKey(ownTeam, teamId)
  const canQuery = open && (ownTeam || Boolean(teamId))

  const driversQuery = useQuery<TeamSpxDriversResponse>({
    queryKey,
    queryFn: () => {
      if (ownTeam) return currentTeamApi.listDrivers()
      if (!teamId) {
        return Promise.resolve({
          drivers: [],
          summary: { total: 0, enabled: 0, lastSyncedAt: null, byVehicleType: [] },
        })
      }
      return teamsApi.listDrivers(teamId)
    },
    enabled: canQuery,
  })

  // Reset filters and page when switching teams or closing/reopening the dialog so stale filters never hide another team's drivers.
  useEffect(() => {
    setSearch('')
    setVehicleTypeFilter('all')
    setPage(1)
  }, [open, teamId, ownTeam])

  useEffect(() => {
    setPage(1)
  }, [search, vehicleTypeFilter])

  const invalidateForTarget = (targetOwnTeam: boolean, targetTeamId?: number | null) => {
    queryClient.invalidateQueries({ queryKey: buildDriversQueryKey(targetOwnTeam, targetTeamId) })
    if (targetOwnTeam) {
      queryClient.invalidateQueries({ queryKey: ['current-team'] })
    } else {
      queryClient.invalidateQueries({ queryKey: ['teams'] })
    }
  }

  const syncMutation = useMutation({
    mutationFn: async (vars: { targetOwnTeam: boolean; targetTeamId?: number | null }) => {
      if (vars.targetOwnTeam) return currentTeamApi.syncDrivers()
      if (!vars.targetTeamId) throw new Error('ไม่พบรหัสทีม')
      return teamsApi.syncDrivers(vars.targetTeamId)
    },
    onSuccess: (res, vars) => {
      const targetKey = buildDriversQueryKey(vars.targetOwnTeam, vars.targetTeamId)
      queryClient.setQueryData<TeamSpxDriversResponse>(targetKey, {
        drivers: res.drivers,
        summary: res.summary,
      })
      invalidateForTarget(vars.targetOwnTeam, vars.targetTeamId)
      toast.success(`ดึงรายชื่อคนขับจาก SPX สำเร็จ ${res.synced.toLocaleString()} คน`, {
        description: `เพิ่มใหม่ ${res.inserted} · อัปเดต ${res.updated} · ลบออก ${res.removed}`,
      })
    },
    onError: (err: Error) => {
      toast.error('ดึงรายชื่อคนขับจาก SPX ไม่สำเร็จ', {
        description: err.message,
      })
    },
  })

  const toggleMutation = useMutation({
    mutationFn: async (vars: {
      driverId: number
      enabled: boolean
      targetOwnTeam: boolean
      targetTeamId?: number | null
    }) => {
      if (vars.targetOwnTeam) return currentTeamApi.updateDriverEnabled(vars.driverId, vars.enabled)
      if (!vars.targetTeamId) throw new Error('ไม่พบรหัสทีม')
      return teamsApi.updateDriverEnabled(vars.targetTeamId, vars.driverId, vars.enabled)
    },
    onSuccess: (updated: TeamSpxDriver, vars) => {
      const targetKey = buildDriversQueryKey(vars.targetOwnTeam, vars.targetTeamId)
      queryClient.setQueryData<TeamSpxDriversResponse>(targetKey, (prev) => {
        if (!prev) return prev
        const drivers = prev.drivers.map((item) => (item.driverId === updated.driverId ? updated : item))
        const enabled = drivers.filter((item) => item.enabled).length
        const byTypeMap = new Map<number, { vehicleType: number; vehicleTypeName: string; total: number; enabled: number }>()
        for (const item of drivers) {
          const entry = byTypeMap.get(item.vehicleType) ?? {
            vehicleType: item.vehicleType,
            vehicleTypeName: item.vehicleTypeName || `Type ${item.vehicleType}`,
            total: 0,
            enabled: 0,
          }
          entry.total++
          if (item.enabled) entry.enabled++
          byTypeMap.set(item.vehicleType, entry)
        }
        return {
          drivers,
          summary: {
            ...prev.summary,
            total: drivers.length,
            enabled,
            byVehicleType: [...byTypeMap.values()].sort((a, b) => b.total - a.total || a.vehicleType - b.vehicleType),
          },
        }
      })
      invalidateForTarget(vars.targetOwnTeam, vars.targetTeamId)
    },
    onError: (err: Error) => {
      toast.error('เปลี่ยนสถานะคนขับไม่สำเร็จ', { description: err.message })
    },
  })

  const bulkToggleMutation = useMutation({
    mutationFn: async (vars: {
      enabled: boolean
      vehicleType?: number
      targetOwnTeam: boolean
      targetTeamId?: number | null
    }) => {
      if (vars.targetOwnTeam) return currentTeamApi.setAllDriversEnabled(vars.enabled, vars.vehicleType)
      if (!vars.targetTeamId) throw new Error('ไม่พบรหัสทีม')
      return teamsApi.setAllDriversEnabled(vars.targetTeamId, vars.enabled, vars.vehicleType)
    },
    onSuccess: (res, vars) => {
      const targetKey = buildDriversQueryKey(vars.targetOwnTeam, vars.targetTeamId)
      queryClient.setQueryData<TeamSpxDriversResponse>(targetKey, {
        drivers: res.drivers,
        summary: res.summary,
      })
      invalidateForTarget(vars.targetOwnTeam, vars.targetTeamId)
      toast.success(`${vars.enabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}คนขับ ${res.updatedCount} คนแล้ว`)
    },
    onError: (err: Error) => {
      toast.error('อัปเดตสถานะคนขับทั้งหมดไม่สำเร็จ', { description: err.message })
    },
  })

  const anyMutationPending = syncMutation.isPending || toggleMutation.isPending || bulkToggleMutation.isPending

  const drivers = useMemo(() => driversQuery.data?.drivers ?? [], [driversQuery.data?.drivers])
  const summary = useMemo(
    () =>
      driversQuery.data?.summary ?? {
        total: 0,
        enabled: 0,
        lastSyncedAt: null,
        byVehicleType: [],
      },
    [driversQuery.data?.summary],
  )

  useEffect(() => {
    if (
      vehicleTypeFilter !== 'all'
      && summary.byVehicleType.length > 0
      && !summary.byVehicleType.some((vt) => vt.vehicleType === vehicleTypeFilter)
    ) {
      setVehicleTypeFilter('all')
    }
  }, [summary.byVehicleType, vehicleTypeFilter])

  const filteredDrivers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return drivers.filter((driver) => {
      if (vehicleTypeFilter !== 'all' && driver.vehicleType !== vehicleTypeFilter) {
        return false
      }
      if (!q) return true
      return (
        driver.driverName.toLowerCase().includes(q)
        || String(driver.driverId).includes(q)
        || driver.vehicleTypeName.toLowerCase().includes(q)
        || driver.agencyName.toLowerCase().includes(q)
      )
    })
  }, [drivers, search, vehicleTypeFilter])

  const totalPages = Math.max(1, Math.ceil(filteredDrivers.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginatedDrivers = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE
    return filteredDrivers.slice(start, start + PAGE_SIZE)
  }, [filteredDrivers, safePage])

  const activeVehicleTypeParam = vehicleTypeFilter === 'all' ? undefined : vehicleTypeFilter

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel="ปิดหน้าต่าง"
        className="max-h-[90dvh] overflow-y-auto rounded-2xl border border-white/10 sm:max-w-[820px]"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-bold">
            <Truck className="h-5 w-5 text-primary" />
            <span>รายชื่อคนขับ SPX (Auto-Assign){teamName ? ` — ${teamName}` : ''}</span>
          </DialogTitle>
          <DialogDescription>
            กดดึงรายชื่อคนขับทั้งหมดจาก SPX มาเก็บไว้ในฐานข้อมูล ระบบจะสุ่มวนเลือกคนขับที่เปิดใช้งานตามประเภทรถโดยไม่ให้ชื่อซ้ำกันตอนรับงาน
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Sync & Summary Banner */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold text-foreground flex items-center gap-1.5">
                    <Users className="h-4 w-4 text-primary" />
                    คนขับในฐานข้อมูล: <span className="font-data text-primary">{summary.total.toLocaleString()}</span> คน
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    พร้อมใช้ Auto {summary.enabled.toLocaleString()} คน
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {summary.lastSyncedAt
                    ? `ซิงก์ล่าสุดเมื่อ ${formatDateTime(summary.lastSyncedAt)}`
                    : 'ยังไม่ได้ดึงข้อมูลคนขับจาก SPX — กดปุ่ม "ดึงข้อมูลคนขับจาก SPX" เพื่อเริ่มต้น'}
                </p>
              </div>

              <Button
                type="button"
                onClick={() => syncMutation.mutate({ targetOwnTeam: ownTeam, targetTeamId: teamId })}
                disabled={anyMutationPending}
                className="gap-2 shrink-0"
              >
                {syncMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                <span>{syncMutation.isPending ? 'กำลังดึงข้อมูล...' : 'ดึงข้อมูลคนขับจาก SPX'}</span>
              </Button>
            </div>

            {summary.byVehicleType.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-2 border-t border-white/[0.06]">
                <button
                  type="button"
                  onClick={() => setVehicleTypeFilter('all')}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    vehicleTypeFilter === 'all'
                      ? 'border-primary/40 bg-primary/15 text-primary'
                      : 'border-white/10 bg-white/[0.03] text-muted-foreground hover:text-foreground'
                  }`}
                >
                  ทั้งหมด ({summary.total})
                </button>
                {summary.byVehicleType.map((vt) => (
                  <button
                    key={vt.vehicleType}
                    type="button"
                    onClick={() => setVehicleTypeFilter(vt.vehicleType)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                      vehicleTypeFilter === vt.vehicleType
                        ? 'border-primary/40 bg-primary/15 text-primary'
                        : 'border-white/10 bg-white/[0.03] text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {vt.vehicleTypeName} ({vt.enabled}/{vt.total})
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* Search & Bulk Toggle Controls */}
          {summary.total > 0 ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="ค้นหาชื่อคนขับ, Driver ID หรือประเภทรถ..."
                  className="pl-9 pr-8 h-9 text-sm"
                />
                {search ? (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label="ล้างคำค้นหา"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 text-xs"
                  disabled={anyMutationPending}
                  onClick={() =>
                    bulkToggleMutation.mutate({
                      enabled: true,
                      vehicleType: activeVehicleTypeParam,
                      targetOwnTeam: ownTeam,
                      targetTeamId: teamId,
                    })
                  }
                >
                  เปิดใช้ทั้งหมด
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 text-xs text-muted-foreground"
                  disabled={anyMutationPending}
                  onClick={() =>
                    bulkToggleMutation.mutate({
                      enabled: false,
                      vehicleType: activeVehicleTypeParam,
                      targetOwnTeam: ownTeam,
                      targetTeamId: teamId,
                    })
                  }
                >
                  ปิดทั้งหมด
                </Button>
              </div>
            </div>
          ) : null}

          {/* Driver Table */}
          {driversQuery.isLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>กำลังโหลดรายชื่อคนขับ...</span>
            </div>
          ) : driversQuery.isError ? (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-xs text-danger">
              โหลดรายชื่อคนขับไม่สำเร็จ: {driversQuery.error instanceof Error ? driversQuery.error.message : String(driversQuery.error)}
            </div>
          ) : filteredDrivers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] py-10 px-4 text-center text-sm text-muted-foreground">
              <Truck className="mx-auto mb-2 h-8 w-8 opacity-30" />
              <p className="font-medium text-foreground">
                {summary.total === 0 ? 'ยังไม่มีข้อมูลคนขับในฐานข้อมูล' : 'ไม่พบคนขับที่ตรงกับตัวกรอง'}
              </p>
              <p className="mt-1 text-xs">
                {summary.total === 0
                  ? 'กดปุ่ม "ดึงข้อมูลคนขับจาก SPX" ด้านบนเพื่อดึงรายชื่อคนขับทั้งหมดเข้ามาเก็บไว้'
                  : 'ลองเปลี่ยนคำค้นหาหรือเลือกประเภทรถอื่น'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="max-h-[360px] overflow-auto rounded-xl border border-white/10">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-white/10 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 font-medium w-24">Driver ID</th>
                      <th className="px-3 py-2.5 font-medium">ชื่อคนขับ</th>
                      <th className="px-3 py-2.5 font-medium w-44">ประเภทรถ</th>
                      <th className="px-3 py-2.5 font-medium w-28">เอเจนซี่</th>
                      <th className="px-3 py-2.5 font-medium w-24 text-right">ใช้ Auto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05]">
                    {paginatedDrivers.map((driver) => (
                      <tr key={driver.driverId} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2 font-mono text-muted-foreground">{driver.driverId}</td>
                        <td className="px-3 py-2 font-medium text-foreground">{driver.driverName}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          <span className="inline-flex items-center rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px]">
                            {driver.vehicleTypeName || `Type ${driver.vehicleType}`}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground truncate max-w-[110px]" title={driver.agencyName}>
                          {driver.agencyName || '-'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Switch
                            checked={driver.enabled}
                            disabled={anyMutationPending}
                            onCheckedChange={(checked) =>
                              toggleMutation.mutate({
                                driverId: driver.driverId,
                                enabled: checked,
                                targetOwnTeam: ownTeam,
                                targetTeamId: teamId,
                              })
                            }
                            aria-label={`เปิดใช้คนขับ ${driver.driverName}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 ? (
                <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                  <span>
                    แสดง {((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filteredDrivers.length)} จาก {filteredDrivers.length.toLocaleString()} คน
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={safePage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <span className="font-data px-1">
                      {safePage} / {totalPages}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
