import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { aiApi, settingsApi } from '../lib/api'
import { Card } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { toast } from 'sonner'
import {
    Wifi,
    Bell,
    MessageCircle,
    Settings2,
    KeyRound,
    Bot,
    Lock,
    CheckCircle2,
    XCircle,
    Loader2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const INITIAL_SETTINGS_FORM = {
    API_URL: '',
    POLL_INTERVAL_MS: '30000',
    COOKIE: '',
    DEVICE_ID: '',
    LINE_CHANNEL_ACCESS_TOKEN: '',
    LINE_USER_ID: '',
    LINEJS_TEST_ENABLED: 'false',
    LINEJS_TEST_TARGET_ID: '',
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: '',
    LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: '',
    LINEJS_TEST_DEVICE: 'IOSIPAD',
    LINEJS_TEST_STORAGE_PATH: 'data/linejs-storage.json',
    DISCORD_WEBHOOK_URL: '',
    BOOKING_DETAIL_CONCURRENCY: '8',
    CODEX_IMAGE_PROVIDER: 'auto',
}

export type SettingsForm = typeof INITIAL_SETTINGS_FORM

export interface SettingsFormContextValue {
    formData: SettingsForm
    setField: (key: keyof SettingsForm, value: string) => void
    save: () => void
    reset: () => void
    isSaving: boolean
    isDirty: boolean
}

const SettingsFormContext = React.createContext<SettingsFormContextValue | null>(null)

/**
 * Single source of truth for the Settings form. Mounted once at
 * `/settings` and consumed by each child route via `useSettingsForm`.
 *
 * Keeps the form state co-located with the parent route so navigating
 * between sub-tabs preserves unsaved edits, and the sticky save bar
 * has a stable view of the dirty state across all children.
 */
export function SettingsFormProvider({ children }: { children: React.ReactNode }) {
    const queryClient = useQueryClient()
    const [formData, setFormData] = React.useState<SettingsForm>(INITIAL_SETTINGS_FORM)
    const [isDirty, setIsDirty] = React.useState(false)

    const { data: settings } = useQuery({
        queryKey: ['settings'],
        queryFn: settingsApi.get,
        staleTime: 5 * 60 * 1000,
    })

    React.useEffect(() => {
        if (!settings) return
        setFormData({
            API_URL: settings.API_URL || '',
            POLL_INTERVAL_MS: settings.POLL_INTERVAL_MS || '30000',
            COOKIE: settings.COOKIE || '',
            DEVICE_ID: settings.DEVICE_ID || '',
            LINE_CHANNEL_ACCESS_TOKEN: settings.LINE_CHANNEL_ACCESS_TOKEN || '',
            LINE_USER_ID: settings.LINE_USER_ID || '',
            LINEJS_TEST_ENABLED: settings.LINEJS_TEST_ENABLED || 'false',
            LINEJS_TEST_TARGET_ID: settings.LINEJS_TEST_TARGET_ID || '',
            LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS:
                settings.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS || '',
            LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE:
                settings.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE || '',
            LINEJS_TEST_DEVICE: settings.LINEJS_TEST_DEVICE || 'IOSIPAD',
            LINEJS_TEST_STORAGE_PATH:
                settings.LINEJS_TEST_STORAGE_PATH || 'data/linejs-storage.json',
            DISCORD_WEBHOOK_URL: settings.DISCORD_WEBHOOK_URL || '',
            BOOKING_DETAIL_CONCURRENCY: settings.BOOKING_DETAIL_CONCURRENCY || '8',
            CODEX_IMAGE_PROVIDER: settings.CODEX_IMAGE_PROVIDER || 'auto',
        })
        setIsDirty(false)
    }, [settings])

    const updateMutation = useMutation({
        mutationFn: settingsApi.update,
        onSuccess: () => {
            toast.success('บันทึกการตั้งค่าแล้ว มีผลทันที')
            queryClient.invalidateQueries({ queryKey: ['settings'] })
            queryClient.invalidateQueries({ queryKey: ['line-bot-status'] })
            setIsDirty(false)
        },
        onError: (error) => toast.error('เกิดข้อผิดพลาด: ' + error.message),
    })

    const setField = React.useCallback((key: keyof SettingsForm, value: string) => {
        setFormData((prev) => ({ ...prev, [key]: value }))
        setIsDirty(true)
    }, [])

    const save = React.useCallback(() => {
        updateMutation.mutate(formData)
    }, [updateMutation, formData])

    const reset = React.useCallback(() => {
        if (settings) {
            setFormData(INITIAL_SETTINGS_FORM)
            queryClient.invalidateQueries({ queryKey: ['settings'] })
            setIsDirty(false)
        }
    }, [settings, queryClient])

    const value: SettingsFormContextValue = {
        formData,
        setField,
        save,
        reset,
        isSaving: updateMutation.isPending,
        isDirty,
    }

    return (
        <SettingsFormContext.Provider value={value}>{children}</SettingsFormContext.Provider>
    )
}

export function useSettingsForm(): SettingsFormContextValue {
    const ctx = React.useContext(SettingsFormContext)
    if (!ctx) {
        throw new Error('useSettingsForm must be used within <SettingsFormProvider>')
    }
    return ctx
}

/* ─────────────────────────────────────────────────────────────
   UI primitives shared across all settings sub-routes
   ───────────────────────────────────────────────────────────── */

export function Section({
    title,
    description,
    icon: Icon,
    children,
    rightSlot,
}: {
    title: string
    description?: string
    icon: LucideIcon
    children: React.ReactNode
    rightSlot?: React.ReactNode
}) {
    return (
        <Card className="border-white/[0.06] bg-card shadow-none">
            <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-muted-foreground">
                        <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                        {description ? (
                            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                        ) : null}
                    </div>
                </div>
                {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
            </header>
            <div className="px-5 py-5">{children}</div>
        </Card>
    )
}

export function Field({
    id,
    label,
    hint,
    helper,
    children,
}: {
    id: string
    label: string
    hint?: React.ReactNode
    helper?: string
    children: React.ReactNode
}) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={id} className="text-sm font-medium text-foreground">
                    {label}
                </label>
                {hint ? (
                    <span className="font-data text-xs text-muted-foreground/70">{hint}</span>
                ) : null}
            </div>
            {children}
            {helper ? <p className="text-xs text-muted-foreground/70">{helper}</p> : null}
        </div>
    )
}

export function MaskedHint({ value }: { value: string }) {
    if (!value) return <span className="text-muted-foreground/50">ยังไม่ตั้งค่า</span>
    if (value.startsWith('***')) {
        return (
            <span className="inline-flex items-center gap-1 text-success">
                <CheckCircle2 className="h-3 w-3" />
                masked
            </span>
        )
    }
    return <span className="text-warning">unmasked</span>
}

export function getIntervalSec(pollIntervalMs: string): number {
    const ms = Number(pollIntervalMs || 30000)
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0
}

function getCodexLoginErrorMessage(error: Error): string {
    if (
        /CODEX_AUTH_PROVIDER_UNAVAILABLE|INTERNAL_SERVER_ERROR|Internal server error/i.test(
            error.message
        )
    ) {
        return 'OpenAI/Codex login service is temporarily unavailable. Try again later.'
    }
    return error.message
}

/* ─────────────────────────────────────────────────────────────
   API & Polling section
   ───────────────────────────────────────────────────────────── */
export function ApiSection({
    formData,
    setField,
}: {
    formData: SettingsForm
    setField: (k: keyof SettingsForm, v: string) => void
}) {
    const intervalSec = getIntervalSec(formData.POLL_INTERVAL_MS)
    const concurrency = Number(formData.BOOKING_DETAIL_CONCURRENCY || 0)

    return (
        <div className="space-y-5">
            <Section icon={KeyRound} title="API credentials" description="เชื่อมต่อระบบกับ SPX">
                <div className="space-y-4">
                    <Field id="s-api-url" label="SPX API URL" helper="URL สำหรับเรียก booking/bidding/list">
                        <Input
                            id="s-api-url"
                            value={formData.API_URL}
                            onChange={(e) => setField('API_URL', e.target.value)}
                            placeholder="https://logistics.example.com/api/..."
                        />
                    </Field>

                    <Field
                        id="s-cookie"
                        label="Cookie"
                        helper="Session cookie จาก SPX — ค่าจะ masked หากไม่เปลี่ยนจะไม่ถูกเขียนทับ"
                        hint={<MaskedHint value={formData.COOKIE} />}
                    >
                        <textarea
                            id="s-cookie"
                            value={formData.COOKIE}
                            onChange={(e) => setField('COOKIE', e.target.value)}
                            className="flex min-h-[6rem] w-full resize-y rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                            placeholder="fms_user_id=...; session=..."
                        />
                    </Field>

                    <Field id="s-device-id" label="Device ID" helper="UUID ของอุปกรณ์ที่ผูกกับ session ปัจจุบัน">
                        <Input
                            id="s-device-id"
                            value={formData.DEVICE_ID}
                            onChange={(e) => setField('DEVICE_ID', e.target.value)}
                            placeholder="e.g. 7342ce6cb4d0fdc351..."
                        />
                    </Field>
                </div>
            </Section>

            <Section icon={Settings2} title="Polling behaviour" description="รอบดึงงานและจำนวน request พร้อมกัน">
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                        id="s-poll"
                        label="Poll interval"
                        hint={intervalSec ? `≈ ${intervalSec}s` : ''}
                        helper="ช่วงเวลาระหว่างการเช็คงานใหม่ (มิลลิวินาที)"
                    >
                        <Input
                            id="s-poll"
                            value={formData.POLL_INTERVAL_MS}
                            onChange={(e) => setField('POLL_INTERVAL_MS', e.target.value)}
                            placeholder="30000"
                            inputMode="numeric"
                        />
                    </Field>

                    <Field
                        id="s-concurrency"
                        label="Detail concurrency"
                        hint={concurrency > 0 ? `${concurrency} jobs` : ''}
                        helper="จำนวน request ดึงรายละเอียดงานพร้อมกัน"
                    >
                        <Input
                            id="s-concurrency"
                            value={formData.BOOKING_DETAIL_CONCURRENCY}
                            onChange={(e) => setField('BOOKING_DETAIL_CONCURRENCY', e.target.value)}
                            placeholder="8"
                            inputMode="numeric"
                        />
                    </Field>

                    <Field
                        id="s-codex-provider"
                        label="AI image provider"
                        helper="เลือก codex-device เพื่ออ่านรูป LINE ผ่าน OAuth ของ OpenAI"
                    >
                        <select
                            id="s-codex-provider"
                            value={formData.CODEX_IMAGE_PROVIDER}
                            onChange={(e) => setField('CODEX_IMAGE_PROVIDER', e.target.value)}
                            className="flex h-10 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        >
                            <option value="auto" className="bg-popover">auto (ใช้ตัวที่พร้อมใช้)</option>
                            <option value="codex-device" className="bg-popover">codex-device (OAuth)</option>
                            <option value="codex-cli" className="bg-popover">codex-cli (local)</option>
                        </select>
                    </Field>
                </div>
            </Section>

            <CodexAuthSection />
        </div>
    )
}

function CodexAuthSection() {
    const queryClient = useQueryClient()
    const codexStatus = useQuery({
        queryKey: ['codex-device-auth-status'],
        queryFn: aiApi.codexAuthStatus,
        staleTime: 10 * 1000,
        refetchInterval: (query) => {
            const data = query.state.data
            return data?.hasPendingDeviceCode || data?.hasPendingFlow ? 3000 : false
        },
    })
    const startCodexAuth = useMutation({
        mutationFn: aiApi.codexAuthStart,
        onSuccess: (data) => {
            const targetUrl =
                data.authorizationUrl || data.verificationUriComplete || data.verificationUri
            if (targetUrl) window.open(targetUrl, '_blank', 'noopener,noreferrer')
            toast.success(data.mode === 'device' ? 'เริ่ม device-code login' : 'เริ่ม browser login')
            queryClient.invalidateQueries({ queryKey: ['codex-device-auth-status'] })
        },
        onError: (error) =>
            toast.error('เริ่ม Codex login ไม่สำเร็จ', {
                description: getCodexLoginErrorMessage(error),
                duration: 15_000,
            }),
    })
    const completeCodexAuth = useMutation({
        mutationFn: aiApi.codexAuthComplete,
        onSuccess: () => {
            toast.success('Codex device auth พร้อมใช้งาน')
            queryClient.invalidateQueries({ queryKey: ['codex-device-auth-status'] })
        },
        onError: (error) => toast.error('Codex complete failed: ' + error.message),
    })
    const logoutCodexAuth = useMutation({
        mutationFn: aiApi.codexAuthLogout,
        onSuccess: () => {
            toast.success('ลบ Codex device auth แล้ว')
            queryClient.invalidateQueries({ queryKey: ['codex-device-auth-status'] })
        },
        onError: (error) => toast.error('Codex logout failed: ' + error.message),
    })

    const isAuthenticated = Boolean(codexStatus.data?.authenticated)
    const isPending = codexStatus.data?.hasPendingDeviceCode || codexStatus.data?.hasPendingFlow

    const promptCodexCallback = () => {
        const callbackUrl = window.prompt('วาง callback URL หรือ code จากหน้า OpenAI login')
        if (!callbackUrl?.trim()) return
        completeCodexAuth.mutate({ callbackUrl: callbackUrl.trim() })
    }

    return (
        <Section
            icon={Bot}
            title="Codex device auth"
            description="OpenAI OAuth สำหรับอ่านรูปภาพจาก LINE"
            rightSlot={
                <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${isAuthenticated
                            ? 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success'
                            : isPending
                                ? 'border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] text-warning'
                                : 'border-white/10 bg-white/[0.04] text-muted-foreground'
                        }`}
                >
                    {isAuthenticated ? (
                        <>
                            <CheckCircle2 className="h-3 w-3" />
                            เชื่อมต่อแล้ว
                        </>
                    ) : isPending ? (
                        <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            กำลังรอ
                        </>
                    ) : (
                        <>
                            <XCircle className="h-3 w-3" />
                            ยังไม่เชื่อมต่อ
                        </>
                    )}
                </span>
            }
        >
            <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                    {codexStatus.data?.accountIdSuffix
                        ? `Account ...${codexStatus.data.accountIdSuffix}`
                        : 'Login ครั้งเดียว ระบบจะใช้ token นี้อ่านรูปจาก LINE โดยอัตโนมัติ'}
                </p>

                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => startCodexAuth.mutate({ mode: 'browser' })}
                        disabled={startCodexAuth.isPending}
                    >
                        <KeyRound className="h-3.5 w-3.5" />
                        Browser login
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => startCodexAuth.mutate({ mode: 'device' })}
                        disabled={startCodexAuth.isPending}
                    >
                        Device code
                    </Button>
                    {!codexStatus.data?.hasPendingDeviceCode ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={promptCodexCallback}
                            disabled={completeCodexAuth.isPending}
                        >
                            วาง callback URL
                        </Button>
                    ) : null}
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-danger hover:text-danger"
                        onClick={() => logoutCodexAuth.mutate()}
                        disabled={
                            logoutCodexAuth.isPending ||
                            (!isAuthenticated &&
                                !codexStatus.data?.hasPendingDeviceCode &&
                                !codexStatus.data?.hasPendingFlow)
                        }
                    >
                        Logout
                    </Button>
                </div>

                {codexStatus.data?.hasPendingDeviceCode && codexStatus.data?.userCode ? (
                    <div className="rounded-xl border border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] p-4">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-warning/80">
                            วางรหัสนี้ที่หน้า OpenAI
                        </div>
                        <div className="rounded-lg bg-black/30 py-2 text-center font-data text-2xl font-black tracking-[0.3em] text-warning">
                            {codexStatus.data.userCode}
                        </div>
                        <a
                            href={
                                codexStatus.data.verificationUriComplete || codexStatus.data.verificationUri
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                        >
                            เปิดหน้า verification →
                        </a>
                        <p className="mt-2 inline-flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
                            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-warning" aria-hidden="true" />
                            ระบบจะอัปเดตอัตโนมัติเมื่อ login สำเร็จ
                        </p>
                    </div>
                ) : null}

                {codexStatus.data?.hasPendingFlow ? (
                    <div className="rounded-xl border border-primary/22 bg-primary/[0.06] p-4">
                        <div className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary/80">
                            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-primary" aria-hidden="true" />
                            กำลังรอ callback อัตโนมัติ
                        </div>
                        <p className="mb-3 text-xs text-muted-foreground">
                            ถ้าไม่ต่อกลับเอง ให้คัดลอกลิงก์จาก address bar หลัง login แล้ววางที่นี่:
                        </p>
                        <input
                            type="text"
                            placeholder="http://localhost:1455/auth/callback?code=..."
                            className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary focus:outline-none"
                            onPaste={(e) => {
                                const val = e.clipboardData.getData('text').trim()
                                if (val) {
                                    completeCodexAuth.mutate({ callbackUrl: val })
                                    e.currentTarget.value = ''
                                }
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    const val = e.currentTarget.value.trim()
                                    if (val) {
                                        completeCodexAuth.mutate({ callbackUrl: val })
                                        e.currentTarget.value = ''
                                    }
                                }
                            }}
                        />
                    </div>
                ) : null}
            </div>
        </Section>
    )
}

/* ─────────────────────────────────────────────────────────────
   Notifications section
   ───────────────────────────────────────────────────────────── */
export function NotifySection({
    formData,
    setField,
}: {
    formData: SettingsForm
    setField: (k: keyof SettingsForm, v: string) => void
}) {
    return (
        <div className="space-y-5">
            <Section
                icon={MessageCircle}
                title="LINE Official Account"
                description="ส่ง push message ผ่าน LINE Messaging API"
            >
                <div className="space-y-4">
                    <Field
                        id="s-line-token"
                        label="Channel access token"
                        helper="Token สำหรับส่ง push message ผ่าน LINE Messaging API"
                        hint={<MaskedHint value={formData.LINE_CHANNEL_ACCESS_TOKEN} />}
                    >
                        <Input
                            id="s-line-token"
                            value={formData.LINE_CHANNEL_ACCESS_TOKEN}
                            onChange={(e) => setField('LINE_CHANNEL_ACCESS_TOKEN', e.target.value)}
                            placeholder="********"
                        />
                    </Field>
                    <Field
                        id="s-line-uid"
                        label="User / Group ID"
                        helper="ใช้ Group ID ขึ้นต้นด้วย C เพื่อส่งเข้ากลุ่ม"
                    >
                        <Input
                            id="s-line-uid"
                            value={formData.LINE_USER_ID}
                            onChange={(e) => setField('LINE_USER_ID', e.target.value)}
                            placeholder="Uxxx... หรือ Cxxx..."
                        />
                    </Field>
                </div>
            </Section>

            <Section
                icon={Bell}
                title="Discord webhook"
                description="ส่งแจ้งเตือนเข้า channel Discord ผ่าน webhook"
            >
                <Field
                    id="s-discord"
                    label="Webhook URL"
                    helper="สร้าง webhook ใน channel Discord ที่ต้องการรับแจ้งเตือน"
                    hint={
                        formData.DISCORD_WEBHOOK_URL ? null : (
                            <span className="text-muted-foreground/50">ยังไม่ตั้งค่า</span>
                        )
                    }
                >
                    <Input
                        id="s-discord"
                        value={formData.DISCORD_WEBHOOK_URL}
                        onChange={(e) => setField('DISCORD_WEBHOOK_URL', e.target.value)}
                        placeholder="https://discord.com/api/webhooks/..."
                    />
                </Field>
            </Section>

            <div className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-muted-foreground">
                    <Lock className="h-3.5 w-3.5" />
                </div>
                <div>
                    <p className="text-sm font-medium text-foreground">Routing แบบละเอียด</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        ไปที่{' '}
                        <strong className="text-foreground">LINE Bot</strong> เพื่อกำหนดปลายทางแยกตาม rule match, auto-accept สำเร็จ และ auto-accept ล้มเหลว
                    </p>
                </div>
            </div>
        </div>
    )
}

void Wifi
