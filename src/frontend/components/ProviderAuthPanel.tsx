import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardAuthExpiredError, providerAuthApi, ProviderAuthRequestError } from '../lib/api'
import { selectProviderAuthFeedbackCode } from '../lib/provider-auth-feedback'
import { formatDateTime } from '../lib/utils'
import type { ProviderAuthStatus } from '../types'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'

const SUCCESS_COOLDOWN_MS = 30_000

function timestampMs(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function calculateProviderAuthCooldown(status: Pick<ProviderAuthStatus, 'retryAt' | 'lastLoginAt'>, now = Date.now()): number {
  const retryAt = timestampMs(status.retryAt)
  const lastLoginAt = timestampMs(status.lastLoginAt)
  const targets = [retryAt, lastLoginAt === null ? null : lastLoginAt + SUCCESS_COOLDOWN_MS]
    .filter((value): value is number => value !== null)
  return targets.length === 0 ? 0 : Math.max(0, Math.max(...targets) - now)
}

export function getProviderAuthErrorCopy(code: string | null | undefined): string {
  switch (code) {
    case 'PROVIDER_AUTH_RATE_LIMITED':
    case 'rate_limited':
      return 'บัญชีถูกจำกัดการลองใหม่ชั่วคราว กรุณารอตามเวลาที่ระบุ'
    case 'PROVIDER_AUTH_BUSY':
    case 'busy':
      return 'กำลังมีการเชื่อมต่อบัญชีนี้อยู่ กรุณารอสักครู่'
    case 'PROVIDER_AUTH_NOT_CONFIGURED':
    case 'not_configured':
      return 'ยังไม่มีรหัสผ่านที่บันทึกไว้ กรุณาเชื่อมต่อบัญชีก่อน'
    case 'PROVIDER_AUTH_UNAVAILABLE':
    case 'provider_unavailable':
      return 'ยังเชื่อมต่อผู้ให้บริการไม่ได้ กรุณาลองใหม่อีกครั้ง'
    case 'DASHBOARD_AUTH_REAUTH_REQUIRED':
      return 'เซสชันแดชบอร์ดหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่ แล้วส่งแบบฟอร์มอีกครั้ง'
    case 'challenge_required':
      return 'ผู้ให้บริการต้องการยืนยันตัวตน กรุณาเข้าสู่ MyAgencyService เพื่อทำขั้นตอนยืนยันตัวตนให้เสร็จ แล้วกลับมากดเชื่อมต่ออีกครั้ง'
    case 'PROVIDER_AUTH_FAILED':
    case 'invalid_credentials':
    case 'invalid_input':
    case 'invalid_response':
    case 'stale_operation':
      return 'เชื่อมต่อบัญชีไม่สำเร็จ กรุณาตรวจสอบอีเมลและรหัสผ่านแล้วลองใหม่'
    default:
      return 'ไม่สามารถดำเนินการกับบัญชีผู้ให้บริการได้ กรุณาลองใหม่'
  }
}

function cooldownLabel(remainingMs: number): string {
  return `ลองใหม่ได้ใน ${Math.max(1, Math.ceil(remainingMs / 1_000))} วินาที`
}

function statusLabel(status: ProviderAuthStatus['status']): string {
  return {
    manual: 'ใช้ค่าแบบเดิม',
    connected: 'เชื่อมต่อแล้ว',
    connecting: 'กำลังเชื่อมต่อ',
    attention: 'ต้องตรวจสอบ',
    retry_wait: 'รอลองใหม่',
  }[status]
}

function statusTone(status: ProviderAuthStatus['status']): string {
  if (status === 'connected') return 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success'
  if (status === 'attention' || status === 'retry_wait') return 'border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] text-warning'
  return 'border-white/10 bg-white/[0.04] text-muted-foreground'
}

export function shouldHideProviderAuthPanel({
  hideWhenConnected = false,
  forceExpand = false,
  status,
  hasError = false,
  feedbackCode = null,
  isCoolingDown = false,
}: {
  hideWhenConnected?: boolean
  forceExpand?: boolean
  status?: ProviderAuthStatus | null
  hasError?: boolean
  feedbackCode?: string | null
  isCoolingDown?: boolean
}): boolean {
  if (!hideWhenConnected || forceExpand) return false
  if (hasError) return false
  if (feedbackCode || isCoolingDown) return false
  if (!status) return true
  return status.status === 'connected'
}

export function ProviderAuthPanel({
  teamId,
  className = '',
  hideWhenConnected = false,
  forceExpand = false,
  onDismiss,
}: {
  teamId?: number
  className?: string
  hideWhenConnected?: boolean
  forceExpand?: boolean
  onDismiss?: () => void
}) {
  const scopeKey = teamId === undefined ? 'own-team' : `admin-team-${teamId}`
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [requestFeedback, setRequestFeedback] = useState<{ code: string; readRevision: number } | null>(null)
  const [pending, setPending] = useState<'connect' | 'reconnect' | null>(null)
  const [now, setNow] = useState(Date.now())
  const [rateLimitUntil, setRateLimitUntil] = useState<number | null>(null)
  const activeRequest = useRef(0)
  const mounted = useRef(true)
  const emailInput = useRef<HTMLInputElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)

  const statusQuery = useQuery({ teamId, scopeKey })
  const status = statusQuery.status
  const requestErrorCode = requestFeedback?.code ?? null
  const remainingMs = Math.max(
    status ? calculateProviderAuthCooldown(status, now) : 0,
    rateLimitUntil === null ? 0 : Math.max(0, rateLimitUntil - now),
  )
  const isCoolingDown = remainingMs > 0
  const feedbackCode = selectProviderAuthFeedbackCode({
    statusErrorCode: status?.errorCode,
    requestErrorCode,
    statusConfirmedAfterRequest: requestFeedback !== null && statusQuery.readRevision > requestFeedback.readRevision,
  })

  useEffect(() => {
    mounted.current = true
    activeRequest.current += 1
    setEmail('')
    setPassword('')
    setShowPassword(false)
    setEmailError(null)
    setPasswordError(null)
    setRequestFeedback(null)
    setPending(null)
    setRateLimitUntil(null)
    return () => {
      mounted.current = false
      activeRequest.current += 1
    }
  }, [scopeKey])

  useEffect(() => {
    if (requestFeedback && statusQuery.readRevision > requestFeedback.readRevision) {
      setRequestFeedback(null)
    }
  }, [requestFeedback, statusQuery.readRevision])

  useEffect(() => {
    if (!isCoolingDown) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [isCoolingDown])

  const updateStatus = useCallback((next: ProviderAuthStatus) => {
    statusQuery.setStatus(next)
    setNow(Date.now())
  }, [statusQuery])

  const refreshAfterFailure = async () => {
    await statusQuery.refetch(true)
  }

  const handleConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedEmail = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizedEmail)) {
      setEmailError('กรุณากรอกอีเมลให้ถูกต้อง เช่น operator@example.com')
      emailInput.current?.focus()
      return
    }
    if (!password) {
      setPasswordError('กรุณากรอกรหัสผ่านเพื่อเชื่อมต่อหรือแทนที่บัญชี')
      passwordInput.current?.focus()
      return
    }
    if (pending || isCoolingDown || status?.status === 'connecting' || statusQuery.refreshing) return

    const requestId = ++activeRequest.current
    statusQuery.cancelRead()
    const credentials = { email: normalizedEmail, password }
    setPending('connect')
    setEmailError(null)
    setPasswordError(null)
    setRequestFeedback(null)
    setPassword('')
    try {
      const next = await providerAuthApi.connect(credentials, teamId)
      if (!mounted.current || requestId !== activeRequest.current) return
      updateStatus(next)
      setEmail('')
      setRateLimitUntil(null)
      toast.success('เชื่อมต่อบัญชีผู้ให้บริการแล้ว')
    } catch (error) {
      credentials.password = ''
      if (!mounted.current || requestId !== activeRequest.current) return
      const code = error instanceof DashboardAuthExpiredError
        ? 'DASHBOARD_AUTH_REAUTH_REQUIRED'
        : error instanceof ProviderAuthRequestError ? error.code : undefined
      setRequestFeedback({
        code: code ?? 'PROVIDER_AUTH_UNAVAILABLE',
        readRevision: statusQuery.readRevision,
      })
      if (error instanceof ProviderAuthRequestError && error.retryAfterMs !== null) {
        setRateLimitUntil(Date.now() + error.retryAfterMs)
        setNow(Date.now())
      }
      if (!(error instanceof DashboardAuthExpiredError)) await refreshAfterFailure()
    } finally {
      credentials.password = ''
      if (mounted.current && requestId === activeRequest.current) setPending(null)
    }
  }

  const handleReconnect = async () => {
    if (pending || !status?.hasPassword || isCoolingDown || status.status === 'connecting' || statusQuery.refreshing) return
    const requestId = ++activeRequest.current
    statusQuery.cancelRead()
    setPending('reconnect')
    setRequestFeedback(null)
    try {
      const next = await providerAuthApi.reconnect(teamId)
      if (!mounted.current || requestId !== activeRequest.current) return
      updateStatus(next)
      setRateLimitUntil(null)
      toast.success('เชื่อมต่อบัญชีที่บันทึกไว้อีกครั้งแล้ว')
    } catch (error) {
      if (!mounted.current || requestId !== activeRequest.current) return
      setRequestFeedback({
        code: error instanceof DashboardAuthExpiredError
          ? 'DASHBOARD_AUTH_REAUTH_REQUIRED'
          : error instanceof ProviderAuthRequestError ? error.code : 'PROVIDER_AUTH_UNAVAILABLE',
        readRevision: statusQuery.readRevision,
      })
      if (error instanceof ProviderAuthRequestError && error.retryAfterMs !== null) {
        setRateLimitUntil(Date.now() + error.retryAfterMs)
        setNow(Date.now())
      }
      if (!(error instanceof DashboardAuthExpiredError)) await refreshAfterFailure()
    } finally {
      if (mounted.current && requestId === activeRequest.current) setPending(null)
    }
  }

  if (
    shouldHideProviderAuthPanel({
      hideWhenConnected,
      forceExpand,
      status,
      hasError: statusQuery.error,
      feedbackCode,
      isCoolingDown,
    })
  ) {
    return null
  }

  return (
    <section
      id={teamId === undefined ? 'provider-auth-panel' : undefined}
      tabIndex={teamId === undefined ? -1 : undefined}
      className={`rounded-[8px] border border-white/10 bg-white/[0.025] p-4 ${className}`}
      aria-labelledby={`provider-auth-heading-${scopeKey}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <h2 id={`provider-auth-heading-${scopeKey}`} className="text-sm font-semibold text-foreground">บัญชีผู้ให้บริการ</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">เชื่อมต่อบัญชีที่ใช้กับทีมนี้ รหัสผ่านจะแสดงเฉพาะขณะกรอก</p>
        </div>
        <div className="flex items-center gap-2">
          {status ? <span className={`status-pill shrink-0 ${statusTone(status.status)}`}>{statusQuery.error ? 'ยังยืนยันสถานะไม่ได้' : statusLabel(status.status)}</span> : null}
          {onDismiss ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={onDismiss}
            >
              ซ่อน
            </Button>
          ) : null}
        </div>
      </div>

      {statusQuery.loading ? (
        <div className="mt-4 h-20 animate-pulse rounded-[8px] bg-white/[0.04]" aria-label="กำลังโหลดสถานะบัญชี" />
      ) : statusQuery.error ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-[8px] border border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] p-3 text-sm text-warning" role="alert">
          <span>โหลดสถานะบัญชีไม่สำเร็จ</span>
          <Button type="button" variant="outline" size="sm" onClick={() => { void statusQuery.refetch() }}>ลองใหม่</Button>
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
            <p className="rounded-md bg-black/10 px-3 py-2 text-muted-foreground">อีเมล: <span className="break-all text-foreground">{status?.email || 'ยังไม่ได้เชื่อมต่อ'}</span></p>
            <p className="rounded-md bg-black/10 px-3 py-2 text-muted-foreground">รหัสผ่าน: <span className="text-foreground">{status?.hasPassword ? 'บันทึกแล้ว' : 'ยังไม่มี'}</span></p>
            <p className="rounded-md bg-black/10 px-3 py-2 text-muted-foreground">เข้าสู่ระบบล่าสุด: <span className="text-foreground">{status?.lastLoginAt ? formatDateTime(status.lastLoginAt) : '—'}</span></p>
            <p className="rounded-md bg-black/10 px-3 py-2 text-muted-foreground">หมดอายุ: <span className="text-foreground">{status?.expiresAt ? formatDateTime(status.expiresAt) : '—'}</span></p>
          </div>

          {feedbackCode || isCoolingDown ? (
            <div className="mt-3 flex items-start gap-2 rounded-[8px] border border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] p-3 text-xs text-warning" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                {feedbackCode ? <p>{getProviderAuthErrorCopy(feedbackCode)}</p> : null}
                {isCoolingDown ? <p>{cooldownLabel(remainingMs)}</p> : null}
              </div>
            </div>
          ) : null}

          {statusQuery.refreshing ? <p className="mt-3 text-xs text-muted-foreground" role="status">กำลังอัปเดตสถานะบัญชี</p> : null}
          {statusQuery.refreshExhausted ? (
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-warning" role="status">
              <span>ยังยืนยันผลการเชื่อมต่อไม่ได้ กรุณาตรวจสอบสถานะอีกครั้ง</span>
              <Button type="button" size="sm" variant="outline" onClick={() => { void statusQuery.refetch() }}>ตรวจสอบสถานะ</Button>
            </div>
          ) : null}

          <form className="mt-4 grid gap-3" noValidate onSubmit={handleConnect}>
            <div className="grid gap-2">
              <Label htmlFor={`provider-email-${scopeKey}`}>อีเมล</Label>
              <Input
                id={`provider-email-${scopeKey}`}
                type="email"
                autoComplete="username"
                value={email}
                ref={emailInput}
                onChange={(event) => { setEmail(event.target.value); setEmailError(null) }}
                aria-invalid={Boolean(emailError)}
                aria-describedby={emailError ? `provider-email-error-${scopeKey}` : undefined}
                placeholder="operator@example.com"
                disabled={pending !== null}
              />
              {emailError ? <p id={`provider-email-error-${scopeKey}`} className="text-xs text-danger" role="alert">{emailError}</p> : null}
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`provider-password-${scopeKey}`}>รหัสผ่าน</Label>
              <div className="relative">
                <Input
                  id={`provider-password-${scopeKey}`}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  ref={passwordInput}
                  onChange={(event) => { setPassword(event.target.value); setPasswordError(null) }}
                  aria-invalid={Boolean(passwordError)}
                  aria-describedby={passwordError ? `provider-password-error-${scopeKey}` : undefined}
                  className="pr-11"
                  disabled={pending !== null}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-10 w-10"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                  disabled={pending !== null}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              {passwordError ? <p id={`provider-password-error-${scopeKey}`} className="text-xs text-danger" role="alert">{passwordError}</p> : null}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button type="submit" disabled={pending !== null || statusQuery.refreshing || status?.status === 'connecting' || isCoolingDown || !email.trim() || !password}>
                {pending === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {status?.hasPassword ? 'แทนที่บัญชี' : 'เชื่อมต่อบัญชี'}
              </Button>
              <Button type="button" variant="outline" onClick={handleReconnect} disabled={pending !== null || statusQuery.refreshing || status?.status === 'connecting' || !status?.hasPassword || isCoolingDown}>
                {pending === 'reconnect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                เชื่อมต่ออีกครั้ง
              </Button>
            </div>
          </form>
        </>
      )}
    </section>
  )
}

function useQuery({ teamId, scopeKey }: { teamId?: number; scopeKey: string }) {
  const [status, setStatus] = useState<ProviderAuthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshExhausted, setRefreshExhausted] = useState(false)
  const [readRevision, setReadRevision] = useState(0)
  const request = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const refreshAttempts = useRef(0)

  const cancelRead = useCallback(() => {
    request.current += 1
    controller.current?.abort()
    controller.current = null
  }, [])

  const refetch = useCallback(async (background = false) => {
    cancelRead()
    const requestId = ++request.current
    const abort = new AbortController()
    controller.current = abort
    const deadline = window.setTimeout(() => abort.abort(), 10_000)
    if (!background) {
      setLoading(true)
      refreshAttempts.current = 0
      setRefreshExhausted(false)
    }
    setRefreshing(true)
    setError(false)
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(new Error('status_read_cancelled')), { once: true })
      })
      const next = await Promise.race([providerAuthApi.get(teamId, abort.signal), cancelled])
      if (requestId !== request.current) return
      setStatus(next)
      setReadRevision((revision) => revision + 1)
      return next
    } catch {
      if (requestId !== request.current) return
      setError(true)
    } finally {
      window.clearTimeout(deadline)
      abort.abort()
      if (requestId === request.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [teamId, cancelRead])

  const acceptStatus = useCallback((next: ProviderAuthStatus) => {
    cancelRead()
    setStatus(next)
    setError(false)
    setLoading(false)
    setRefreshing(false)
  }, [cancelRead])

  useEffect(() => {
    setStatus(null)
    void refetch()
    return cancelRead
  }, [refetch, scopeKey, cancelRead])

  useEffect(() => {
    if (status?.status !== 'connecting') {
      refreshAttempts.current = 0
      setRefreshExhausted(false)
      return
    }
    if (refreshing || loading || error) return
    // Cover the server's 120-second lease, then require an explicit safe read.
    if (refreshAttempts.current >= 24) {
      setRefreshExhausted(true)
      return
    }
    const timer = window.setTimeout(() => {
      refreshAttempts.current += 1
      void refetch(true)
    }, 5_000)
    return () => window.clearTimeout(timer)
  }, [status, refreshing, loading, error, refetch])

  return { status, setStatus: acceptStatus, loading, error, refreshing, refreshExhausted, readRevision, refetch, cancelRead }
}
