import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { aiApi, settingsApi } from '../lib/api'
import { Card } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { toast } from 'sonner'
import {
    Bell,
    MessageCircle,
    Settings2,
    KeyRound,
    Bot,
    Lock,
    CheckCircle2,
    Loader2,
    ArrowLeft,
    Plus,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
    Dialog,
    DialogContent,
    DialogTitle,
    DialogDescription,
} from '../components/ui/dialog'

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
    BIDDING_VEHICLE_TYPE: '13',
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
            BIDDING_VEHICLE_TYPE: settings.BIDDING_VEHICLE_TYPE ?? '13',
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
                        id="s-bidding-vehicle-type"
                        label="Bidding vehicle type"
                        helper="vehicle_type สำหรับ booking/bidding/list; เว้นว่างเพื่อดึงทุกประเภทรถ"
                    >
                        <Input
                            id="s-bidding-vehicle-type"
                            value={formData.BIDDING_VEHICLE_TYPE}
                            onChange={(e) => setField('BIDDING_VEHICLE_TYPE', e.target.value)}
                            placeholder="13"
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

function OpenAILogo(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 256 260"
            fill="currentColor"
            {...props}
        >
            <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205Z"/>
        </svg>
    )
}

function CodexAuthSection() {
    const queryClient = useQueryClient()
    const [isDialogOpen, setIsDialogOpen] = React.useState(false)

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
            setIsDialogOpen(true)
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
            setIsDialogOpen(false)
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
    const isPending = Boolean(codexStatus.data?.hasPendingDeviceCode || codexStatus.data?.hasPendingFlow)

    React.useEffect(() => {
        if (isAuthenticated) {
            setIsDialogOpen(false)
        }
    }, [isAuthenticated])

    return (
        <Section
            icon={Bot}
            title="AI Providers"
            description="จัดการการเชื่อมต่อบริการ AI สำหรับอ่าน Runsheet"
        >
            <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-white/[0.06] pb-4 last:border-0 last:pb-0">
                    <div className="flex items-center gap-3.5">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 border border-white/[0.08] text-white">
                            <OpenAILogo className="h-5 w-5" />
                        </div>
                        <div>
                            <h4 className="text-sm font-semibold text-foreground">OpenAI</h4>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                {isAuthenticated && codexStatus.data?.accountIdSuffix ? (
                                    <span className="text-success inline-flex items-center gap-1.5">
                                        <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                                        เชื่อมต่อแล้ว (Account ...{codexStatus.data.accountIdSuffix})
                                    </span>
                                ) : isPending ? (
                                    <span className="text-warning inline-flex items-center gap-1.5">
                                        <span className="h-1.5 w-1.5 rounded-full bg-warning animate-ping" />
                                        กำลังรอการเชื่อมต่อ...
                                    </span>
                                ) : (
                                    "GPT models for fast, capable general AI tasks"
                                )}
                            </p>
                        </div>
                    </div>
                    <div>
                        {isAuthenticated ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground hover:bg-white/[0.04] hover:text-white"
                                onClick={() => logoutCodexAuth.mutate()}
                                disabled={logoutCodexAuth.isPending}
                            >
                                Disconnect
                            </Button>
                        ) : (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="border-white/[0.1] hover:bg-white/[0.05]"
                                onClick={() => setIsDialogOpen(true)}
                            >
                                <Plus className="mr-1 h-3.5 w-3.5" />
                                Connect
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogContent className="max-w-md bg-slate-950 border border-white/[0.08] text-foreground p-0 overflow-hidden shadow-2xl rounded-2xl">
                    {/* Header */}
                    <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    if (isPending) {
                                        logoutCodexAuth.mutate()
                                    } else {
                                        setIsDialogOpen(false)
                                    }
                                }}
                                className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/[0.05] text-muted-foreground hover:text-foreground transition-colors"
                            >
                                <ArrowLeft className="h-4 w-4" />
                            </button>
                            <DialogTitle className="text-sm font-semibold text-foreground">
                                Connect OpenAI
                            </DialogTitle>
                        </div>
                    </div>

                    {/* Body */}
                    <div className="px-5 py-6">
                        {!isPending ? (
                            <div className="space-y-4">
                                <div>
                                    <DialogDescription className="text-xs text-muted-foreground">
                                        Select login method for OpenAI.
                                    </DialogDescription>
                                </div>

                                <div className="rounded-xl border border-white/[0.08] bg-white/[0.01] divide-y divide-white/[0.06] overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => startCodexAuth.mutate({ mode: 'browser' })}
                                        className="w-full flex items-center justify-between p-4 hover:bg-white/[0.03] text-left transition-colors group"
                                        disabled={startCodexAuth.isPending}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-5 w-5 items-center justify-center rounded border border-white/20 text-transparent group-hover:border-primary">
                                                <span className="h-1.5 w-1.5 rounded-full bg-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                                            </div>
                                            <div>
                                                <span className="text-sm font-medium text-foreground">ChatGPT Pro/Plus (browser)</span>
                                            </div>
                                        </div>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => startCodexAuth.mutate({ mode: 'device' })}
                                        className="w-full flex items-center justify-between p-4 hover:bg-white/[0.03] text-left transition-colors group"
                                        disabled={startCodexAuth.isPending}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-5 w-5 items-center justify-center rounded border border-white/20 text-transparent group-hover:border-primary">
                                                <span className="h-1.5 w-1.5 rounded-full bg-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                                            </div>
                                            <div>
                                                <span className="text-sm font-medium text-foreground">ChatGPT Pro/Plus (headless)</span>
                                            </div>
                                        </div>
                                    </button>

                                    <div
                                        className="flex items-center justify-between p-4 opacity-40 cursor-not-allowed select-none bg-white/[0.01]"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-5 w-5 items-center justify-center rounded border border-white/10 text-transparent">
                                                <span className="h-1.5 w-1.5 rounded-full bg-transparent" />
                                            </div>
                                            <div>
                                                <span className="text-sm font-medium text-foreground">API key <span className="text-[10px] text-muted-foreground ml-1.5">(Coming soon)</span></span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-5">
                                {codexStatus.data?.hasPendingFlow && (
                                    <div className="space-y-4">
                                        <div className="flex items-start gap-3 rounded-xl border border-primary/22 bg-primary/[0.03] p-4">
                                            <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-primary">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            </div>
                                            <div className="space-y-1">
                                                <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
                                                    กำลังรอ Callback อัตโนมัติ
                                                </h5>
                                                <p className="text-xs text-muted-foreground leading-relaxed">
                                                    ระบบเปิดแท็บใหม่เพื่อ Login บัญชี OpenAI แล้ว หากทำสำเร็จแท็บจะปิดเองและเชื่อมต่อทันที
                                                </p>
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <label className="text-xs font-medium text-muted-foreground">
                                                หากเบราว์เซอร์ไม่ปิดอัตโนมัติ ให้คัดลอก URL หรือโค้ดมาวางที่นี่:
                                            </label>
                                            <input
                                                type="text"
                                                placeholder="http://localhost:1455/auth/callback?code=..."
                                                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary focus:outline-none transition-colors"
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
                                    </div>
                                )}

                                {codexStatus.data?.hasPendingDeviceCode && codexStatus.data?.userCode && (
                                    <div className="space-y-4 text-center">
                                        <div className="space-y-1">
                                            <span className="text-xs font-semibold text-warning uppercase tracking-wider">
                                                วางรหัสนี้ที่หน้า OpenAI
                                            </span>
                                            <div className="mt-2 rounded-xl bg-black/40 border border-white/[0.06] py-3.5 text-center font-data text-3xl font-black tracking-[0.25em] text-warning shadow-inner">
                                                {codexStatus.data.userCode}
                                            </div>
                                        </div>

                                        <div className="space-y-2.5">
                                            <a
                                                href={codexStatus.data.verificationUriComplete || codexStatus.data.verificationUri}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex w-full items-center justify-center gap-1 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/95 transition-colors shadow-sm"
                                            >
                                                เปิดหน้า verification เพื่อกรอกรหัส →
                                            </a>
                                            <p className="inline-flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
                                                ระบบจะตรวจจับและเชื่อมต่ออัตโนมัติเมื่อกดยืนยันสำเร็จ
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>
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
