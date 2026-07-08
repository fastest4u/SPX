import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { aiApi, settingsApi } from '../lib/api'
import { safeBrowserUrl } from '../lib/utils'
import { Card } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Switch } from '../components/ui/switch'
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
import type { SettingsResponse, SettingReloadBehavior } from '../types'

export const INITIAL_SETTINGS_FORM = {
    API_URL: '',
    APP_NAME: '',
    REFERER: '',
    DEBUG: 'false',
    FETCH_DETAILS: 'false',
    SAVE_TO_DB: 'true',
    POLL_INTERVAL_MS: '30000',
    BOOKING_DETAIL_CONCURRENCY: '8',
    BOOKING_REPROCESS_COOLDOWN_MS: '10000',
    BIDDING_PAGE_NO: '1',
    BIDDING_PAGE_COUNT: '100',
    REQUEST_TAB_PENDING_CONFIRMATION: 'true',
    REQUEST_CTIME_START: '1776358800',
    BIDDING_VEHICLE_TYPE: '13',
    NOTIFY_ENABLED: 'true',
    NOTIFY_MODE: 'batch',
    NOTIFY_ORIGINS: '',
    NOTIFY_DESTINATIONS: '',
    NOTIFY_VEHICLE_TYPES: '',
    NOTIFY_MIN_TRIPS: '1',
    AUTO_ACCEPT_ENABLED: 'false',
    HTTP_ALLOWED_ORIGINS: '',
    HTTP_TRUST_PROXY: 'false',
    JWT_SECRET: '',
    COOKIE_SECRET: '',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: '',
    ADMIN_ROLE: 'admin',
    LINE_CHANNEL_ACCESS_TOKEN: '',
    LINEJS_TEST_ENABLED: 'false',
    LINEJS_TEST_TARGET_ID: '',
    LINEJS_TEST_DEVICE: 'IOSIPAD',
    LINEJS_TEST_STORAGE_PATH: 'data/linejs-storage.json',
    DISCORD_WEBHOOK_URL: '',
    LINE_IMAGE_LISTENER_CHAT_ID: '',
    NOTIFIER_SHARED_SECRET: '',
    NOTIFIER_AUTH_MODE: 'hmac',
    NOTIFIER_REQUEST_TIMEOUT_MS: '1500',
    NOTIFIER_RETRY_MAX_ATTEMPTS: '12',
    NOTIFIER_RETRY_BASE_DELAY_MS: '1000',
    CODEX_IMAGE_MODEL: '',
    CODEX_IMAGE_PROVIDER: 'auto',
    CODEX_IMAGE_TIMEOUT_MS: '300000',
    CODEX_IMAGE_MAX_BYTES: '10485760',
}

export type SettingsForm = typeof INITIAL_SETTINGS_FORM

/** Inline validation errors keyed by form field (only set fields are invalid). */
export type SettingsFieldErrors = Partial<Record<keyof SettingsForm, string>>

export interface SettingsFormContextValue {
    formData: SettingsForm
    reloadBehavior: SettingsResponse['reloadBehavior']
    setField: (key: keyof SettingsForm, value: string) => void
    save: () => void
    reset: () => void
    isSaving: boolean
    isDirty: boolean
    fieldErrors: SettingsFieldErrors
}

type SettingFieldKind = 'text' | 'secret' | 'number' | 'switch' | 'select'

interface SettingFieldOption {
    value: string
    label: string
}

interface SettingFieldDescriptor {
    key: keyof SettingsForm
    label: string
    helper?: string
    placeholder?: string
    kind?: SettingFieldKind
    inputMode?: React.InputHTMLAttributes<HTMLInputElement>['inputMode']
    options?: readonly SettingFieldOption[]
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
    BIDDING_PAGE_NO: { optional: false, min: 1 },
    BIDDING_PAGE_COUNT: { optional: false, min: 1 },
    REQUEST_CTIME_START: { optional: false, min: 0 },
    BIDDING_VEHICLE_TYPE: { optional: true, min: 1 },
    NOTIFY_MIN_TRIPS: { optional: false, min: 1 },
    NOTIFIER_REQUEST_TIMEOUT_MS: { optional: false, min: 1 },
    NOTIFIER_RETRY_MAX_ATTEMPTS: { optional: false, min: 1 },
    NOTIFIER_RETRY_BASE_DELAY_MS: { optional: false, min: 1 },
    CODEX_IMAGE_TIMEOUT_MS: { optional: false, min: 1 },
    CODEX_IMAGE_MAX_BYTES: { optional: false, min: 1 },
} as const satisfies Partial<
    Record<keyof SettingsForm, { optional: boolean; min?: number; max?: number }>
>

const API_IDENTITY_FIELDS = [
    {
        key: 'API_URL',
        label: 'SPX API URL',
        helper: 'URL สำหรับเรียก booking/bidding/list',
        placeholder: 'https://logistics.example.com/api/...',
    },
    {
        key: 'APP_NAME',
        label: 'App name',
        helper: 'ชื่อระบบที่ใช้ใน worker และหน้าจัดการ',
        placeholder: 'SPX',
    },
    {
        key: 'REFERER',
        label: 'Referer',
        helper: 'ค่า Referer ที่แนบไปกับ request เข้า SPX',
        placeholder: 'https://logistics.example.com/',
    },
] as const satisfies readonly SettingFieldDescriptor[]

const RUNTIME_FLAG_FIELDS = [
    {
        key: 'DEBUG',
        label: 'Debug logging',
        helper: 'เปิด log รายละเอียดเพิ่มสำหรับตรวจปัญหา',
        kind: 'switch',
    },
    {
        key: 'FETCH_DETAILS',
        label: 'Fetch details',
        helper: 'ดึงรายละเอียด booking หลังเจองานใน list',
        kind: 'switch',
    },
    {
        key: 'SAVE_TO_DB',
        label: 'Save to DB',
        helper: 'บันทึก booking และประวัติลงฐานข้อมูล',
        kind: 'switch',
    },
    {
        key: 'AUTO_ACCEPT_ENABLED',
        label: 'Auto accept',
        helper: 'เปิดระบบรับงานอัตโนมัติตาม rule',
        kind: 'switch',
    },
] as const satisfies readonly SettingFieldDescriptor[]

const REQUEST_WINDOW_FIELDS = [
    {
        key: 'POLL_INTERVAL_MS',
        label: 'Poll interval',
        helper: 'ช่วงเวลาระหว่างการเช็คงานใหม่ (มิลลิวินาที)',
        placeholder: '30000',
        kind: 'number',
        inputMode: 'numeric',
    },
    {
        key: 'BOOKING_DETAIL_CONCURRENCY',
        label: 'Detail concurrency',
        helper: 'จำนวน request ดึงรายละเอียดงานพร้อมกัน (1-50)',
        placeholder: '8',
        kind: 'number',
        inputMode: 'numeric',
    },
    {
        key: 'BOOKING_REPROCESS_COOLDOWN_MS',
        label: 'Re-process cooldown',
        helper: 'ข้ามการดึงรายละเอียดงานเดิมซ้ำภายใน N ms (0 = ปิด)',
        placeholder: '0',
        kind: 'number',
        inputMode: 'numeric',
    },
    {
        key: 'BIDDING_PAGE_NO',
        label: 'Bidding page no',
        helper: 'หน้าแรกที่ worker ใช้ดึง booking/bidding/list',
        placeholder: '1',
        kind: 'number',
        inputMode: 'numeric',
    },
    {
        key: 'BIDDING_PAGE_COUNT',
        label: 'Bidding page count',
        helper: 'จำนวนรายการต่อหน้าที่ขอจาก SPX',
        placeholder: '100',
        kind: 'number',
        inputMode: 'numeric',
    },
    {
        key: 'REQUEST_TAB_PENDING_CONFIRMATION',
        label: 'Pending confirmation tab',
        helper: 'ดึงแท็บงานที่รอการยืนยัน',
        kind: 'switch',
    },
    {
        key: 'REQUEST_CTIME_START',
        label: 'Request ctime start',
        helper: 'Unix timestamp เริ่มต้นสำหรับกรอง request',
        placeholder: '1776358800',
        kind: 'number',
        inputMode: 'numeric',
    },
    {
        key: 'BIDDING_VEHICLE_TYPE',
        label: 'Bidding vehicle type',
        helper: 'vehicle_type สำหรับ booking/bidding/list; เว้นว่างเพื่อดึงทุกประเภทรถ',
        placeholder: '13',
        kind: 'number',
        inputMode: 'numeric',
    },
] as const satisfies readonly SettingFieldDescriptor[]

const HTTP_AUTH_FIELDS = [
    {
        key: 'HTTP_ALLOWED_ORIGINS',
        label: 'HTTP allowed origins',
        helper: 'origin ที่อนุญาตสำหรับ CORS คั่นด้วย comma',
        placeholder: 'https://example.com,https://admin.example.com',
    },
    {
        key: 'HTTP_TRUST_PROXY',
        label: 'HTTP trust proxy',
        helper: 'เชื่อ proxy header เมื่ออยู่หลัง reverse proxy',
        kind: 'switch',
    },
    {
        key: 'JWT_SECRET',
        label: 'JWT secret',
        helper: 'เว้นค่า masked ไว้เพื่อใช้ secret เดิม',
        placeholder: '********',
        kind: 'secret',
    },
    {
        key: 'COOKIE_SECRET',
        label: 'Cookie secret',
        helper: 'เว้นค่า masked ไว้เพื่อใช้ secret เดิม',
        placeholder: '********',
        kind: 'secret',
    },
    {
        key: 'ADMIN_USERNAME',
        label: 'Admin username',
        helper: 'บัญชี admin เริ่มต้นของระบบ',
        placeholder: 'admin',
    },
    {
        key: 'ADMIN_PASSWORD',
        label: 'Admin password',
        helper: 'เว้นค่า masked ไว้เพื่อใช้ password เดิม',
        placeholder: '********',
        kind: 'secret',
    },
    {
        key: 'ADMIN_ROLE',
        label: 'Admin role',
        helper: 'สิทธิ์เริ่มต้นของบัญชี admin',
        kind: 'select',
        options: [
            { value: 'admin', label: 'admin' },
            { value: 'user', label: 'user' },
        ],
    },
] as const satisfies readonly SettingFieldDescriptor[]

const AI_IMAGE_FIELDS = [
    {
        key: 'CODEX_IMAGE_PROVIDER',
        label: 'AI image provider',
        helper: 'เลือก codex-device เพื่ออ่านรูป LINE ผ่าน OAuth ของ OpenAI',
        kind: 'select',
        options: [
            { value: 'auto', label: 'auto (ใช้ตัวที่พร้อมใช้)' },
            { value: 'codex-device', label: 'codex-device (OAuth)' },
            { value: 'codex-cli', label: 'codex-cli (local)' },
        ],
    },
    {
        key: 'CODEX_IMAGE_MODEL',
        label: 'Codex image model',
        helper: 'model ที่ใช้แยกข้อมูลจากรูป runsheet',
        placeholder: 'gpt-5-mini',
    },
    {
        key: 'CODEX_IMAGE_TIMEOUT_MS',
        label: 'Codex image timeout',
        helper: 'timeout สำหรับอ่านรูป LINE (มิลลิวินาที)',
        placeholder: '300000',
        kind: 'number',
        inputMode: 'numeric',
    },
    {
        key: 'CODEX_IMAGE_MAX_BYTES',
        label: 'Codex image max bytes',
        helper: 'ขนาดรูปสูงสุดที่ส่งให้ AI',
        placeholder: '10485760',
        kind: 'number',
        inputMode: 'numeric',
    },
] as const satisfies readonly SettingFieldDescriptor[]

const NOTIFY_FILTER_FIELDS = [
    {
        key: 'NOTIFY_ENABLED',
        label: 'Notify enabled',
        helper: 'เปิดส่งแจ้งเตือนกลาง',
        kind: 'switch',
    },
    {
        key: 'NOTIFY_MODE',
        label: 'Notify mode',
        helper: 'รูปแบบการรวมข้อความแจ้งเตือน',
        kind: 'select',
        options: [
            { value: 'each', label: 'each' },
            { value: 'batch', label: 'batch' },
        ],
    },
    {
        key: 'NOTIFY_ORIGINS',
        label: 'Notify origins',
        helper: 'ต้นทางที่ต้องการแจ้งเตือน คั่นด้วย comma',
        placeholder: 'Bangkok,Rayong',
    },
    {
        key: 'NOTIFY_DESTINATIONS',
        label: 'Notify destinations',
        helper: 'ปลายทางที่ต้องการแจ้งเตือน คั่นด้วย comma',
        placeholder: 'Laem Chabang',
    },
    {
        key: 'NOTIFY_VEHICLE_TYPES',
        label: 'Notify vehicle types',
        helper: 'ประเภทรถที่ต้องการแจ้งเตือน คั่นด้วย comma',
        placeholder: '13,14',
    },
    {
        key: 'NOTIFY_MIN_TRIPS',
        label: 'Notify min trips',
        helper: 'จำนวนเที่ยวขั้นต่ำก่อนแจ้งเตือน',
        placeholder: '1',
        kind: 'number',
        inputMode: 'numeric',
    },
] as const satisfies readonly SettingFieldDescriptor[]

const NOTIFY_CHANNEL_FIELDS = [
    {
        key: 'LINE_CHANNEL_ACCESS_TOKEN',
        label: 'Channel access token',
        helper: 'Token สำหรับส่ง push message ผ่าน LINE Messaging API',
        placeholder: '********',
        kind: 'secret',
    },
    {
        key: 'DISCORD_WEBHOOK_URL',
        label: 'Discord webhook URL',
        helper: 'webhook ของ channel Discord ที่ต้องการรับแจ้งเตือน',
        placeholder: 'https://discord.com/api/webhooks/...',
        kind: 'secret',
    },
    {
        key: 'LINE_IMAGE_LISTENER_CHAT_ID',
        label: 'Line image listener chat ID',
        helper: 'chat ID สำหรับรับรูป runsheet จาก LINE',
        placeholder: '********',
        kind: 'secret',
    },
] as const satisfies readonly SettingFieldDescriptor[]

const NOTIFIER_RUNTIME_FIELDS = [
    {
        key: 'NOTIFIER_SHARED_SECRET',
        label: 'Notifier shared secret',
        helper: 'secret กลางสำหรับ signer/verifier ของ notifier',
        placeholder: '********',
        kind: 'secret',
    },
    {
        key: 'NOTIFIER_AUTH_MODE',
        label: 'Notifier auth mode',
        helper: 'โหมดตรวจ auth ระหว่าง worker กับ notifier',
        kind: 'select',
        options: [
            { value: 'hmac', label: 'hmac' },
            { value: 'bearer', label: 'bearer' },
        ],
    },
    {
        key: 'NOTIFIER_REQUEST_TIMEOUT_MS',
        label: 'Notifier request timeout',
        helper: 'timeout ต่อ request ไป notifier (มิลลิวินาที)',
        placeholder: '1500',
        kind: 'number',
        inputMode: 'numeric',
    },
    {
        key: 'NOTIFIER_RETRY_MAX_ATTEMPTS',
        label: 'Notifier retry max attempts',
        helper: 'จำนวนครั้ง retry สูงสุดเมื่อส่งแจ้งเตือนล้มเหลว',
        placeholder: '12',
        kind: 'number',
        inputMode: 'numeric',
    },
    {
        key: 'NOTIFIER_RETRY_BASE_DELAY_MS',
        label: 'Notifier retry base delay',
        helper: 'delay เริ่มต้นของ retry backoff (มิลลิวินาที)',
        placeholder: '1000',
        kind: 'number',
        inputMode: 'numeric',
    },
] as const satisfies readonly SettingFieldDescriptor[]

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
function formFromSettings(settings: SettingsResponse): SettingsForm {
    const form: SettingsForm = { ...INITIAL_SETTINGS_FORM }
    for (const key of Object.keys(INITIAL_SETTINGS_FORM) as Array<keyof SettingsForm>) {
        form[key] = settings.values[key] ?? INITIAL_SETTINGS_FORM[key]
    }
    return form
}

function changedReloadBehaviors(
    saved: SettingsForm,
    currentSettings: SettingsResponse | undefined,
): Set<SettingReloadBehavior> {
    const result = new Set<SettingReloadBehavior>()
    const currentForm = currentSettings ? formFromSettings(currentSettings) : INITIAL_SETTINGS_FORM
    const reloadBehavior = currentSettings?.reloadBehavior ?? {}

    for (const key of Object.keys(INITIAL_SETTINGS_FORM) as Array<keyof SettingsForm>) {
        if (saved[key] === currentForm[key]) continue
        result.add(reloadBehavior[key] ?? 'live')
    }

    return result
}

function settingsSavedMessage(
    saved: SettingsForm,
    currentSettings: SettingsResponse | undefined,
): string {
    const behaviors = changedReloadBehaviors(saved, currentSettings)
    if (behaviors.has('restart-process')) {
        return 'บันทึกการตั้งค่าแล้ว บางค่าต้องรีสตาร์ท process จึงจะมีผล'
    }
    if (behaviors.has('restart-worker')) {
        return 'บันทึกการตั้งค่าแล้ว บางค่าต้องรีสตาร์ท worker จึงจะมีผล'
    }
    return 'บันทึกการตั้งค่าแล้ว โหลดค่า live ใหม่แล้ว'
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
        queryFn: settingsApi.getDetailed,
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
        onSuccess: (_data, saved) => {
            toast.success(settingsSavedMessage(saved as SettingsForm, settings))
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
        reloadBehavior: settings?.reloadBehavior ?? {},
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

function fieldId(key: keyof SettingsForm): string {
    return `s-${key.toLowerCase().replace(/_/g, '-')}`
}

function reloadBehaviorText(behavior: SettingReloadBehavior | undefined): string {
    switch (behavior) {
        case 'restart-process':
            return 'restart process'
        case 'restart-worker':
            return 'restart worker'
        case 'live':
        default:
            return 'live'
    }
}

function SettingFieldHint({
    behavior,
    secretValue,
}: {
    behavior: SettingReloadBehavior | undefined
    secretValue?: string
}) {
    return (
        <span className="inline-flex items-center gap-2">
            {secretValue !== undefined ? <MaskedHint value={secretValue} /> : null}
            <span className="font-data text-[0.65rem] uppercase text-muted-foreground/70">
                {reloadBehaviorText(behavior)}
            </span>
        </span>
    )
}

function SettingFieldGrid({
    fields,
    formData,
    setField,
    columns = 'sm:grid-cols-2',
}: {
    fields: readonly SettingFieldDescriptor[]
    formData: SettingsForm
    setField: (k: keyof SettingsForm, v: string) => void
    columns?: string
}) {
    return (
        <div className={`grid gap-4 ${columns}`}>
            {fields.map((field) => (
                <SettingFieldControl
                    key={field.key}
                    field={field}
                    formData={formData}
                    setField={setField}
                />
            ))}
        </div>
    )
}

function SettingFieldControl({
    field,
    formData,
    setField,
}: {
    field: SettingFieldDescriptor
    formData: SettingsForm
    setField: (k: keyof SettingsForm, v: string) => void
}) {
    const { fieldErrors, reloadBehavior } = useSettingsForm()
    const value = formData[field.key] ?? ''
    const id = fieldId(field.key)
    const error = fieldErrors[field.key]
    const kind = field.kind ?? 'text'
    const describedBy = error ? `${id}-error` : undefined
    const hint = (
        <SettingFieldHint
            behavior={reloadBehavior[field.key]}
            secretValue={kind === 'secret' ? value : undefined}
        />
    )

    return (
        <Field
            id={id}
            label={field.label}
            helper={field.helper}
            error={error}
            hint={hint}
        >
            {kind === 'switch' ? (
                <div className="flex h-10 items-center gap-3">
                    <Switch
                        id={id}
                        checked={value === 'true'}
                        onCheckedChange={(checked) => setField(field.key, checked ? 'true' : 'false')}
                    />
                    <span className="text-sm text-muted-foreground">
                        {value === 'true' ? 'เปิด' : 'ปิด'}
                    </span>
                </div>
            ) : kind === 'select' ? (
                <select
                    id={id}
                    value={value}
                    onChange={(e) => setField(field.key, e.target.value)}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                    {(field.options ?? []).map((option) => (
                        <option key={option.value} value={option.value} className="bg-popover">
                            {option.label}
                        </option>
                    ))}
                </select>
            ) : (
                <Input
                    id={id}
                    value={value}
                    onChange={(e) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    inputMode={field.inputMode}
                    type={kind === 'secret' ? 'password' : 'text'}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy}
                />
            )}
        </Field>
    )
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
                <SettingFieldGrid fields={API_IDENTITY_FIELDS} formData={formData} setField={setField} />
            </Section>

            <Section icon={Settings2} title="Runtime flags" description="สวิตช์หลักของ worker และ auto-accept">
                <SettingFieldGrid
                    fields={RUNTIME_FLAG_FIELDS}
                    formData={formData}
                    setField={setField}
                    columns="sm:grid-cols-2 lg:grid-cols-4"
                />
            </Section>

            <Section icon={Settings2} title="Polling behaviour" description="รอบดึงงานและจำนวน request พร้อมกัน">
                <SettingFieldGrid
                    fields={REQUEST_WINDOW_FIELDS}
                    formData={formData}
                    setField={setField}
                    columns="sm:grid-cols-2 xl:grid-cols-4"
                />
            </Section>

            <Section icon={Lock} title="HTTP & Auth" description="ค่า dashboard/API และบัญชี admin เริ่มต้น">
                <SettingFieldGrid
                    fields={HTTP_AUTH_FIELDS}
                    formData={formData}
                    setField={setField}
                    columns="sm:grid-cols-2 xl:grid-cols-4"
                />
            </Section>

            <Section icon={Bot} title="AI image extraction" description="provider, model, timeout, และขนาดไฟล์สำหรับอ่านรูป LINE">
                <SettingFieldGrid fields={AI_IMAGE_FIELDS} formData={formData} setField={setField} />
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
                icon={Bell}
                title="Notification filters"
                description="เงื่อนไขกลางก่อนส่งแจ้งเตือน"
            >
                <SettingFieldGrid
                    fields={NOTIFY_FILTER_FIELDS}
                    formData={formData}
                    setField={setField}
                    columns="sm:grid-cols-2 xl:grid-cols-3"
                />
            </Section>

            <Section
                icon={MessageCircle}
                title="Notification channels"
                description="LINE OA, Discord, และ LINE image listener"
            >
                <SettingFieldGrid fields={NOTIFY_CHANNEL_FIELDS} formData={formData} setField={setField} />
            </Section>

            <Section
                icon={Lock}
                title="Notifier runtime"
                description="auth, timeout, และ retry สำหรับ central notifier"
            >
                <SettingFieldGrid
                    fields={NOTIFIER_RUNTIME_FIELDS}
                    formData={formData}
                    setField={setField}
                    columns="sm:grid-cols-2 xl:grid-cols-3"
                />
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
