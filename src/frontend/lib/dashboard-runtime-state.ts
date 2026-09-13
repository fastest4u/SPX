import type { AuthUser, MetricsSnapshot, Team } from '../types'

/** Matches the backend runtime metrics/read-model stale boundary. */
export const DASHBOARD_POLL_FRESHNESS_MS = 120_000
/** Matches the default worker poll cadence without adding high-frequency API traffic. */
export const DASHBOARD_TEAM_RUNTIME_REFRESH_MS = 30_000
export const DASHBOARD_STATUS_CLOCK_INTERVAL_MS = 5_000

export type DashboardTeamControlState = {
  canToggle: boolean
  command: 'enable' | 'disable' | null
  disabled: boolean
  primaryLabel: 'Live' | 'Paused' | 'Off' | 'Stopped' | 'Setup' | 'Session expired' | 'Error' | 'Unknown' | 'Stale'
  primaryTone: 'live' | 'paused' | 'off' | 'unknown' | 'error'
  title: string
  runtimeReason: string
  healthLabel: string
  healthTone: 'healthy' | 'degraded' | 'unknown'
}

type DashboardMetricsObservation = Pick<MetricsSnapshot, 'teamId' | 'isPaused' | 'lastPoll' | 'session'>

function observedPollTimestamp(
  team: Pick<Team, 'id'> | null | undefined,
  metrics: DashboardMetricsObservation | null | undefined,
  nowMs: number,
): number | null {
  if (!team || !metrics || metrics.teamId !== team.id || !metrics.lastPoll.timestamp) return null
  const timestampMs = Date.parse(metrics.lastPoll.timestamp)
  if (!Number.isFinite(timestampMs) || timestampMs > nowMs) return null
  return timestampMs
}

function providerAccountState(
  team: Pick<Team, 'id' | 'runtimeStatus'> | null | undefined,
  metrics: DashboardMetricsObservation | null | undefined,
  nowMs: number,
): Pick<DashboardTeamControlState, 'healthLabel' | 'healthTone'> {
  if (team?.runtimeStatus === 'session_expired') {
    return { healthLabel: 'บัญชีผู้ให้บริการ: Session หมดอายุ', healthTone: 'degraded' }
  }
  const timestampMs = observedPollTimestamp(team, metrics, nowMs)
  if (timestampMs === null) {
    return { healthLabel: 'บัญชีผู้ให้บริการ: ยังไม่ยืนยัน', healthTone: 'unknown' }
  }
  if (metrics?.lastPoll.status === 'session_expired') {
    return { healthLabel: 'บัญชีผู้ให้บริการ: Session หมดอายุ', healthTone: 'degraded' }
  }
  if (!metrics?.session.isHealthy) {
    return { healthLabel: 'บัญชีผู้ให้บริการ: ต้องตรวจสอบ', healthTone: 'degraded' }
  }
  if (nowMs - timestampMs > DASHBOARD_POLL_FRESHNESS_MS) {
    return { healthLabel: 'บัญชีผู้ให้บริการ: ล่าสุดปกติ (ข้อมูลเก่า)', healthTone: 'unknown' }
  }
  return { healthLabel: 'บัญชีผู้ให้บริการ: ปกติ', healthTone: 'healthy' }
}

const successfulPollStatuses = new Set(['ok', 'changed', 'same', 'first'])

function runtimeState(
  team: Pick<Team, 'id' | 'enabled' | 'runtimeStatus'> | null | undefined,
  metrics: DashboardMetricsObservation | null | undefined,
  nowMs: number,
): Pick<DashboardTeamControlState, 'primaryLabel' | 'primaryTone' | 'runtimeReason'> {
  if (!team) {
    return { primaryLabel: 'Unknown', primaryTone: 'unknown', runtimeReason: 'ยังไม่พบทีมที่ใช้ยืนยันสถานะ Worker' }
  }
  if (!team.enabled) {
    return { primaryLabel: 'Off', primaryTone: 'off', runtimeReason: 'ทีมปิดใช้งานอยู่' }
  }
  if (team.runtimeStatus === 'stopped') {
    return { primaryLabel: 'Stopped', primaryTone: 'off', runtimeReason: 'ทีมเปิดใช้งานอยู่ แต่ Worker หยุดทำงาน' }
  }
  if (team.runtimeStatus === 'paused') {
    return { primaryLabel: 'Paused', primaryTone: 'paused', runtimeReason: 'Worker พักการ poll ชั่วคราว' }
  }
  if (team.runtimeStatus === 'misconfigured') {
    return { primaryLabel: 'Setup', primaryTone: 'error', runtimeReason: 'Worker ยังตั้งค่าไม่ครบ' }
  }
  if (team.runtimeStatus === 'session_expired') {
    return { primaryLabel: 'Session expired', primaryTone: 'error', runtimeReason: 'Session ผู้ให้บริการหมดอายุ' }
  }
  if (team.runtimeStatus === 'error') {
    return { primaryLabel: 'Error', primaryTone: 'error', runtimeReason: 'Worker พบข้อผิดพลาด' }
  }
  if (team.runtimeStatus !== 'running') {
    return { primaryLabel: 'Unknown', primaryTone: 'unknown', runtimeReason: 'ยังไม่ยืนยันสถานะ Worker' }
  }
  if (!metrics || metrics.teamId !== team.id) {
    return {
      primaryLabel: 'Unknown',
      primaryTone: 'unknown',
      runtimeReason: metrics ? 'ข้อมูล metrics ไม่ตรงกับทีม' : 'ยังไม่มีข้อมูล metrics ของทีม',
    }
  }
  if (metrics.isPaused) {
    return { primaryLabel: 'Paused', primaryTone: 'paused', runtimeReason: 'Worker พักการ poll ชั่วคราว' }
  }
  const timestampMs = observedPollTimestamp(team, metrics, nowMs)
  if (timestampMs === null) {
    return { primaryLabel: 'Unknown', primaryTone: 'unknown', runtimeReason: 'ยังไม่มีเวลาผล poll ที่ยืนยันได้' }
  }
  if (metrics.lastPoll.status === 'session_expired') {
    return { primaryLabel: 'Session expired', primaryTone: 'error', runtimeReason: 'Session ผู้ให้บริการหมดอายุ' }
  }
  if (nowMs - timestampMs > DASHBOARD_POLL_FRESHNESS_MS) {
    return { primaryLabel: 'Stale', primaryTone: 'paused', runtimeReason: 'ไม่พบผล poll ใหม่ภายใน 120 วินาที' }
  }
  if (!metrics.lastPoll.status) {
    return { primaryLabel: 'Unknown', primaryTone: 'unknown', runtimeReason: 'ยังไม่มีสถานะผล poll ที่ยืนยันได้' }
  }
  if (!successfulPollStatuses.has(metrics.lastPoll.status)) {
    return {
      primaryLabel: 'Error',
      primaryTone: 'error',
      runtimeReason: `ผล poll ล่าสุดล้มเหลว (${metrics.lastPoll.status})`,
    }
  }
  if (!metrics.session.isHealthy) {
    return { primaryLabel: 'Error', primaryTone: 'error', runtimeReason: 'Worker ทำงานอยู่ แต่บัญชีผู้ให้บริการต้องตรวจสอบ' }
  }
  return { primaryLabel: 'Live', primaryTone: 'live', runtimeReason: 'Worker ทำงานและมีผล poll ล่าสุด' }
}

export function getDashboardTeamControlState({
  user,
  team,
  metrics,
  nowMs,
  isMutating,
}: {
  user: AuthUser | null
  team?: Pick<Team, 'id' | 'name' | 'enabled' | 'runtimeStatus'> | null
  metrics?: DashboardMetricsObservation | null
  nowMs: number
  isMutating: boolean
}): DashboardTeamControlState {
  const isOwnTeamUser = user?.role === 'user' && typeof user.teamId === 'number' && team?.id === user.teamId
  const teamEnabled = team?.enabled === true
  const command = isOwnTeamUser ? (teamEnabled ? 'disable' : 'enable') : null
  const runtime = runtimeState(team, metrics, nowMs)
  const provider = providerAccountState(team, metrics, nowMs)
  const action = isOwnTeamUser && team
    ? `กดเพื่อ${teamEnabled ? 'ปิด' : 'เปิด'}ระบบบิทของทีม ${team.name}`
    : null
  const readonlyTitle = user?.role === 'admin'
    ? 'Admin ดูสถานะจาก Dashboard ได้เท่านั้น ใช้หน้า Teams เพื่อเลือกทีมและจัดการระบบบิท'
    : 'ยังไม่พบทีมของผู้ใช้ จึงเปิดหรือปิดระบบบิทจาก Dashboard ไม่ได้'

  return {
    canToggle: isOwnTeamUser,
    command,
    disabled: !isOwnTeamUser || isMutating,
    ...runtime,
    title: action ? `${runtime.runtimeReason} — ${action}` : readonlyTitle,
    ...provider,
  }
}
