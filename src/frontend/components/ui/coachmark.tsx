import * as React from 'react'
import { Sparkles, X, Check } from 'lucide-react'
import { Button } from './button'
import { cn } from '../../lib/utils'

const STORAGE_KEY = 'spx:coachmark:v1'

export interface CoachmarkStep {
    /** Markdown / plain title shown bold. */
    title: React.ReactNode
    /** Supporting copy. */
    body: React.ReactNode
    /** Optional CTA on the step (e.g. "เปิดทันที"). */
    action?: { label: React.ReactNode; onClick: () => void }
}

const DEFAULT_STEPS: CoachmarkStep[] = [
    {
        title: 'ยินดีต้อนรับสู่ SPX Control Center',
        body: 'จัดการ rule การ bid, ดู metrics real-time, และตั้งค่า notification ได้จากที่เดียว ปรับ density ตารางและคีย์ลัดได้ตามถนัด',
    },
    {
        title: 'ค้นหาเร็วด้วย ⌘K',
        body: 'กด Cmd+K (Ctrl+K) เปิด quick search กระโดดข้ามหน้าได้ทันที พิมพ์ชื่อหน้าและกด Enter',
    },
    {
        title: 'ปรับมุมมองตารางได้',
        body: 'มุมขวาบนของทุกตาราง: เลือกคอลัมน์ที่ต้องการ ปรับ density (หนาแน่น/ปกติ/โปร่ง) และจะถูกจำให้ครั้งหน้า',
    },
    {
        title: 'ดูสถานะระบบที่ topbar',
        body: 'ไอคอน Live แสดงการเชื่อมต่อ real-time stream Bell แสดงจำนวน warning ที่กำลังเกิด คลิกได้ทั้งคู่',
    },
]

function readDismissed(): boolean {
    if (typeof window === 'undefined') return true
    try {
        return window.localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
        return true
    }
}

function writeDismissed() {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(STORAGE_KEY, '1')
    } catch {
        // ignore
    }
}

/**
 * First-login coachmark / product tour. Renders a small spotlight overlay
 * with a step-through. Dismisses permanently on close (per-browser via
 * localStorage). Safe no-op on subsequent visits.
 *
 * Pass `force` to re-open the tour from a "Show tour again" affordance in
 * settings later.
 */
export function Coachmark({
    steps = DEFAULT_STEPS,
    force = false,
    onDismiss,
}: {
    steps?: CoachmarkStep[]
    force?: boolean
    onDismiss?: () => void
}) {
    const [open, setOpen] = React.useState(() => force || !readDismissed())
    const [step, setStep] = React.useState(0)

    React.useEffect(() => {
        if (force) setOpen(true)
    }, [force])

    if (!open || steps.length === 0) return null
    const current = steps[Math.min(step, steps.length - 1)]
    const isLast = step >= steps.length - 1

    const close = () => {
        setOpen(false)
        writeDismissed()
        onDismiss?.()
    }

    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" role="dialog" aria-label="คำแนะนำการใช้งาน">
            <div
                className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in"
                onClick={close}
                aria-hidden="true"
            />
            <div className="relative w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
                <div className="rounded-2xl border border-primary/22 bg-popover p-5 shadow-2xl">
                    <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-primary/22 bg-primary/10 text-primary">
                                <Sparkles className="h-4 w-4" />
                            </span>
                            <span className="text-[0.7rem] font-bold uppercase tracking-[0.16em] text-primary">
                                แนะนำการใช้งาน · {step + 1}/{steps.length}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={close}
                            aria-label="ปิด"
                            className="rounded-md p-1 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    <h2 className="text-base font-semibold text-foreground">{current.title}</h2>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{current.body}</p>

                    {current.action ? (
                        <div className="mt-3">
                            <Button size="sm" variant="outline" onClick={current.action.onClick}>
                                {current.action.label}
                            </Button>
                        </div>
                    ) : null}

                    <div className="mt-5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                            {steps.map((_, i) => (
                                <span
                                    key={i}
                                    className={cn(
                                        'h-1.5 rounded-full transition-all',
                                        i === step ? 'w-5 bg-primary' : 'w-1.5 bg-white/10'
                                    )}
                                    aria-hidden="true"
                                />
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            {step > 0 ? (
                                <Button size="sm" variant="ghost" onClick={() => setStep((s) => s - 1)}>
                                    ก่อนหน้า
                                </Button>
                            ) : null}
                            {isLast ? (
                                <Button size="sm" onClick={close}>
                                    <Check className="h-4 w-4" />
                                    เริ่มใช้งาน
                                </Button>
                            ) : (
                                <Button size="sm" onClick={() => setStep((s) => s + 1)}>
                                    ถัดไป
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

export function resetCoachmark() {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.removeItem(STORAGE_KEY)
    } catch {
        // ignore
    }
}
