import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { aiApi, settingsApi } from '../lib/api'
import { safeBrowserUrl } from '../lib/utils'
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
    LINE_CHANNEL_ACCESS_TOKEN: '',
    LINEJS_TEST_ENABLED: 'false',
    LINEJS_TEST_TARGET_ID: '',
    LINEJS_TEST_DEVICE: 'IOSIPAD',
    LINEJS_TEST_STORAGE_PATH: 'data/linejs-storage.json',
    DISCORD_WEBHOOK_URL: '',
    BOOKING_DETAIL_CONCURRENCY: '8',
    BOOKING_REPROCESS_COOLDOWN_MS: '0',
    BIDDING_VEHICLE_TYPE: '13',
    CODEX_IMAGE_PROVIDER: 'auto',
}

export type SettingsForm = typeof INITIAL_SETTINGS_FORM

/** Inline validation errors keyed by form field (only set fields are invalid). */
export type SettingsFieldErrors = Partial<Record<keyof SettingsForm, string>>

export interface SettingsFormContextValue {
    formData: SettingsForm
    setField: (key: keyof SettingsForm, value: string) => void
    save: () => void
    reset: () => void
    isSaving: boolean
    isDirty: boolean
    fieldErrors: SettingsFieldErrors
}

/**
 * Numeric field constraints applied before saving. `POLL_INTERVAL_MS` is
 * intentionally given no `min`/`max`: a lower interval is a deliberate operator
 * lever (see backend `validateRuntimeConfig`), so it is only rejected when it is
 * not a positive integer — never floored or clamped to a minimum.
 */
const NUMERIC_FIELD_RULES = {
    POLL_INTERVAL_MS: { optional: false },
    BOOKING_DETAIL_CONCURRENCY: { optional: false, min: 1, max: 50 },
    BOOKING_REPROCESS_COOLDOWN_MS: { optional: false, min: 0 },
    BIDDING_VEHICLE_TYPE: { optional: true, min: 1 },
} as const satisfies Partial<
    Record<keyof SettingsForm, { optional: boolean; min?: number; max?: number }>
>

/**
 * Validate and clamp numeric settings before building the save payload.
 *
 * - Rejects clearly-invalid values (non-numeric, negative, or non-integer) with
 *   a visible inline error and leaves the payload unchanged for that field.
 * - Clamps in-range-but-out-of-bounds integers to the field's sane bounds.
 * - `POLL_INTERVAL_MS` is never clamped to a minimum (operator lever).
 * - Optional fields (e.g. `BIDDING_VEHICLE_TYPE`) accept an empty string.
 */
export function validateNumericFields(form: SettingsForm): {
    errors: SettingsFieldErrors
    sanitized: SettingsForm
} {
    const errors: SettingsFieldErrors = {}
    const sanitized: SettingsForm = { ...form }

    for (const [field, rule] of Object.entries(NUMERIC_FIELD_RULES) as Array<
        [keyof SettingsForm, (typeof NUMERIC_FIELD_RULES)[keyof typeof NUMERIC_FIELD_RULES]]
    >) {
        const raw = (form[field] ?? '').trim()

        if (raw === '') {
            if (rule.optional) {
                sanitized[field] = ''
                continue
            }
            errors[field] = 'ต้องระบุค่าตัวเลข'
            continue
        }

        const num = Number(raw)
        if (!Number.isFinite(num) || !Number.isInteger(num)) {
            errors[field] = 'ต้องเป็นจำนวนเต็ม'
            continue
        }
        const min = 'min' in rule ? rule.min : undefined
        const max = 'max' in rule ? rule.max : undefined
        if (typeof min === 'number' && num < min) {
            errors[field] = min === 0 ? 'ต้องเป็นจำนวนเต็มไม่ติดลบ' : 'ต้องเป็นจำนวนเต็มบวก'
            continue
        }
        if (typeof min !== 'number' && num <= 0) {
            errors[field] = 'ต้องเป็นจำนวนเต็มบวก'
            continue
        }

        let clamped = num
        if (typeof min === 'number' && clamped < min) clamped = min
        if (typeof max === 'number' && clamped > max) clamped = max
        sanitized[field] = String(clamped)
    }

    return { errors, sanitized }
}

const SettingsFormContext = React.createContext<SettingsFormContextValue | null>(null)

/** Build form state from the cached settings query response. */
function formFromSettings(settings: Awaited<ReturnType<typeof settingsApi.get>>): SettingsForm {
    return {
        API_URL: settings.API_URL || '',
        POLL_INTERVAL_MS: settings.POLL_INTERVAL_MS || '30000',
        LINE_CHANNEL_ACCESS_TOKEN: settings.LINE_CHANNEL_ACCESS_TOKEN || '',
        LINEJS_TEST_ENABLED: settings.LINEJS_TEST_ENABLED || 'false',
        LINEJS_TEST_TARGET_ID: settings.LINEJS_TEST_TARGET_ID || '',
        LINEJS_TEST_DEVICE: settings.LINEJS_TEST_DEVICE || 'IOSIPAD',
        LINEJS_TEST_STORAGE_PATH:
            settings.LINEJS_TEST_STORAGE_PATH || 'data/linejs-storage.json',
        DISCORD_WEBHOOK_URL: settings.DISCORD_WEBHOOK_URL || '',
        BOOKING_DETAIL_CONCURRENCY: settings.BOOKING_DETAIL_CONCURRENCY || '8',
        BOOKING_REPROCESS_COOLDOWN_MS: settings.BOOKING_REPROCESS_COOLDOWN_MS || '0',
        BIDDING_VEHICLE_TYPE: settings.BIDDING_VEHICLE_TYPE ?? '13',
        CODEX_IMAGE_PROVIDER: settings.CODEX_IMAGE_PROVIDER || 'auto',
    }
}

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
    const [fieldErrors, setFieldErrors] = React.useState<SettingsFieldErrors>({})

    const { data: settings } = useQuery({
        queryKey: ['settings'],
        queryFn: settingsApi.get,
        staleTime: 5 * 60 * 1000,
    })

    React.useEffect(() => {
        if (!settings) return
        setFormData(formFromSettings(settings))
        setFieldErrors({})
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
        setFieldErrors((prev) => {
            if (!(key in prev)) return prev
            const next = { ...prev }
            delete next[key]
            return next
        })
        setIsDirty(true)
    }, [])

    const save = React.useCallback(() => {
        const { errors, sanitized } = validateNumericFields(formData)
        if (Object.keys(errors).length > 0) {
            setFieldErrors(errors)
            toast.error('ค่าตัวเลขไม่ถูกต้อง โปรดแก้ไขก่อนบันทึก')
            return
        }
        setFieldErrors({})
        // Reflect any clamping back into the form so the user sees the saved value.
        setFormData(sanitized)
        updateMutation.mutate(sanitized)
    }, [updateMutation, formData])

    const reset = React.useCallback(() => {
        if (settings) {
            setFormData(formFromSettings(settings))
            setFieldErrors({})
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
        fieldErrors,
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
        <Card className="min-w-0 max-w-full overflow-hidden rounded-[8px] border-white/[0.06] bg-card/80 shadow-none">
            <header className="flex min-w-0 items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3.5 sm:px-5">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-white/[0.06] bg-white/[0.03] text-muted-foreground">
                        <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                        {description ? (
                            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
                        ) : null}
                    </div>
                </div>
                {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
            </header>
            <div className="px-4 py-4 sm:px-5">{children}</div>
        </Card>
    )
}

export function Field({
    id,
    label,
    hint,
    helper,
    error,
    children,
}: {
    id: string
    label: string
    hint?: React.ReactNode
    helper?: string
    error?: string
    children: React.ReactNode
}) {
    return (
        <div className="space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <label htmlFor={id} className="text-sm font-medium text-foreground">
                    {label}
                </label>
                {hint ? (
                    <span className="font-data text-xs text-muted-foreground/70">{hint}</span>
                ) : null}
            </div>
            {children}
            {error ? (
                <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                    {error}
                </p>
            ) : helper ? (
                <p className="text-xs leading-relaxed text-muted-foreground/70">{helper}</p>
            ) : null}
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
    const { fieldErrors } = useSettingsForm()
    const intervalSec = getIntervalSec(formData.POLL_INTERVAL_MS)
    const concurrency = Number(formData.BOOKING_DETAIL_CONCURRENCY || 0)
    const cooldownMs = Number(formData.BOOKING_REPROCESS_COOLDOWN_MS || 0)
    const providerLabel =
        formData.CODEX_IMAGE_PROVIDER === 'codex-device'
            ? 'OAuth'
            : formData.CODEX_IMAGE_PROVIDER === 'codex-cli'
                ? 'CLI'
                : 'Auto'

    return (
        <div className="min-w-0 space-y-5">
            <div className="grid min-w-0 gap-2 sm:grid-cols-3">
                <SettingMetric label="Poll" value={intervalSec ? `${intervalSec}s` : '-'} helper="interval" />
                <SettingMetric label="Detail" value={concurrency > 0 ? `${concurrency}` : '-'} helper="parallel jobs" />
                <SettingMetric label="AI" value={providerLabel} helper={cooldownMs > 0 ? `cooldown ${Math.round(cooldownMs / 1000)}s` : 'no cooldown'} />
            </div>

            <Section icon={KeyRound} title="SPX API" description="ค่า endpoint กลางที่ใช้ร่วมกันทุกทีม">
                <div className="space-y-4">
                    <Field id="s-api-url" label="SPX API URL" helper="URL สำหรับเรียก booking/bidding/list">
                        <Input
                            id="s-api-url"
                            value={formData.API_URL}
                            onChange={(e) => setField('API_URL', e.target.value)}
                            placeholder="https://logistics.example.com/api/..."
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
                        error={fieldErrors.POLL_INTERVAL_MS}
                    >
                        <Input
                            id="s-poll"
                            value={formData.POLL_INTERVAL_MS}
                            onChange={(e) => setField('POLL_INTERVAL_MS', e.target.value)}
                            placeholder="30000"
                            inputMode="numeric"
                            aria-invalid={fieldErrors.POLL_INTERVAL_MS ? true : undefined}
                            aria-describedby={
                                fieldErrors.POLL_INTERVAL_MS ? 's-poll-error' : undefined
                            }
                        />
                    </Field>

                    <Field
                        id="s-concurrency"
                        label="Detail concurrency"
                        hint={concurrency > 0 ? `${concurrency} jobs` : ''}
                        helper="จำนวน request ดึงรายละเอียดงานพร้อมกัน (1–50)"
                        error={fieldErrors.BOOKING_DETAIL_CONCURRENCY}
                    >
                        <Input
                            id="s-concurrency"
                            value={formData.BOOKING_DETAIL_CONCURRENCY}
                            onChange={(e) => setField('BOOKING_DETAIL_CONCURRENCY', e.target.value)}
                            placeholder="8"
                            inputMode="numeric"
                            aria-invalid={fieldErrors.BOOKING_DETAIL_CONCURRENCY ? true : undefined}
                            aria-describedby={
                                fieldErrors.BOOKING_DETAIL_CONCURRENCY
                                    ? 's-concurrency-error'
                                    : undefined
                            }
                        />
                    </Field>

                    <Field
                        id="s-reprocess-cooldown"
                        label="Re-process cooldown"
                        hint={
                            Number(formData.BOOKING_REPROCESS_COOLDOWN_MS) > 0
                                ? `≈ ${(Number(formData.BOOKING_REPROCESS_COOLDOWN_MS) / 1000).toFixed(1)}s`
                                : 'ปิด'
                        }
                        helper="ข้ามการดึงรายละเอียดงานเดิมซ้ำภายใน N ms — กัน churn เมื่อตั้ง poll interval ต่ำ (0 = ปิด; งานใหม่ไม่ได้รับผลกระทบ)"
                        error={fieldErrors.BOOKING_REPROCESS_COOLDOWN_MS}
                    >
                        <Input
                            id="s-reprocess-cooldown"
                            value={formData.BOOKING_REPROCESS_COOLDOWN_MS}
                            onChange={(e) => setField('BOOKING_REPROCESS_COOLDOWN_MS', e.target.value)}
                            placeholder="0"
                            inputMode="numeric"
                            aria-invalid={fieldErrors.BOOKING_REPROCESS_COOLDOWN_MS ? true : undefined}
                            aria-describedby={
                                fieldErrors.BOOKING_REPROCESS_COOLDOWN_MS
                                    ? 's-reprocess-cooldown-error'
                                    : undefined
                            }
                        />
                    </Field>

                    <Field
                        id="s-bidding-vehicle-type"
                        label="Bidding vehicle type"
                        helper="vehicle_type สำหรับ booking/bidding/list; เว้นว่างเพื่อดึงทุกประเภทรถ"
                        error={fieldErrors.BIDDING_VEHICLE_TYPE}
                    >
                        <Input
                            id="s-bidding-vehicle-type"
                            value={formData.BIDDING_VEHICLE_TYPE}
                            onChange={(e) => setField('BIDDING_VEHICLE_TYPE', e.target.value)}
                            placeholder="13"
                            inputMode="numeric"
                            aria-invalid={fieldErrors.BIDDING_VEHICLE_TYPE ? true : undefined}
                            aria-describedby={
                                fieldErrors.BIDDING_VEHICLE_TYPE
                                    ? 's-bidding-vehicle-type-error'
                                    : undefined
                            }
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

function SettingMetric({
    label,
    value,
    helper,
}: {
    label: string
    value: string
    helper: string
}) {
    return (
        <div className="min-w-0 rounded-[8px] border border-white/[0.06] bg-white/[0.025] px-3 py-2.5">
            <div className="text-[0.65rem] font-semibold uppercase text-muted-foreground">{label}</div>
            <div className="mt-1 flex min-w-0 items-end justify-between gap-2">
                <span className="font-data text-lg font-semibold leading-none text-foreground">{value}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{helper}</span>
            </div>
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
            const targetUrl = safeBrowserUrl(
                data.authorizationUrl || data.verificationUriComplete || data.verificationUri
            )
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
    const verificationUrl = safeBrowserUrl(
        codexStatus.data?.verificationUriComplete || codexStatus.data?.verificationUri
    )

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
                <div className="flex flex-col gap-3 border-b border-white/[0.06] pb-4 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3.5">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-slate-900 border border-white/[0.08] text-white">
                            <OpenAILogo className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
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
                    <div className="sm:shrink-0">
                        {isAuthenticated ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="w-full text-muted-foreground hover:bg-white/[0.04] hover:text-white sm:w-auto"
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
                                className="w-full border-white/[0.1] hover:bg-white/[0.05] sm:w-auto"
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
                <DialogContent className="max-w-md rounded-[8px] border border-white/[0.08] bg-slate-950 p-0 text-foreground shadow-2xl overflow-hidden">
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
                                                className="w-full rounded-[8px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary focus:outline-none transition-colors"
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
                                            {verificationUrl ? (
                                                <a
                                                    href={verificationUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="inline-flex w-full items-center justify-center gap-1 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/95 transition-colors shadow-sm"
                                                >
                                                    เปิดหน้า verification เพื่อกรอกรหัส →
                                                </a>
                                            ) : null}
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

            <div className="flex items-start gap-3 rounded-[8px] border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-white/[0.06] bg-white/[0.03] text-muted-foreground">
                    <Lock className="h-3.5 w-3.5" />
                </div>
                <div>
                    <p className="text-sm font-medium text-foreground">Routing แบบละเอียด</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        ไปที่{' '}
                        <strong className="text-foreground">Teams</strong> เพื่อกำหนด LINE group แยกตามทีม
                    </p>
                </div>
            </div>
        </div>
    )
}
