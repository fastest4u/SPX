import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { rulesApi, teamsApi } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import {
  activationReviewProblem,
  buildRuleInput,
  disabledRulePatch,
  initialRuleValues,
  requiresActivationReview,
  ruleReviewKey,
  type RuleFormErrors,
  type RuleFormValues,
} from '../lib/rule-review'
import type { NotifyRule, RuleInput, RulePreviewResult } from '../types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { VehicleTypeMultiSelect } from './VehicleTypeMultiSelect'
import { RuleReviewSummary, scopeLabels } from './RuleReviewSummary'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  rule?: NotifyRule | null
}
export function RuleEditorDialog(props: Props) {
  const { user } = useAuth()
  if (!props.open) return null
  return (
    <Editor
      key={`${user?.id}:${user?.role}:${user?.teamId}:${props.rule?.id ?? 'new'}`}
      {...props}
      isAdmin={user?.role === 'admin'}
    />
  )
}

function Editor({ rule: openingRule, onOpenChange, isAdmin }: Props & { isAdmin: boolean }) {
  const [rule, setRule] = useState(openingRule)
  const queryClient = useQueryClient()
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const [values, setValues] = useState(() => initialRuleValues(rule))
  const [errors, setErrors] = useState<RuleFormErrors>({})
  const [error, setError] = useState('')
  const [view, setView] = useState<'form' | 'review' | 'discard'>('form')
  const [status, setStatus] = useState<'idle' | 'previewing' | 'saving'>('idle')
  const [preview, setPreview] = useState<RulePreviewResult | null>(null)
  const [reviewedInput, setReviewedInput] = useState<RuleInput | null>(null)
  const [acks, setAcks] = useState({ wildcard: false, acceptAll: false })
  const [now, setNow] = useState(Date.now)
  const form = useRef<HTMLFormElement>(null)
  const errorMessage = useRef<HTMLParagraphElement>(null)
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  const previousView = useRef<'form' | 'review'>('form')
  const epoch = useRef(0)
  const disposed = useRef(false)
  const savePending = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const initial = useRef(JSON.stringify(initialRuleValues(rule)))
  const dirty = JSON.stringify(values) !== initial.current
  const busy = status !== 'idle'
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: teamsApi.list,
    enabled: isAdmin && !rule,
    staleTime: 120_000,
  })
  const input = buildRuleInput(values, { isAdmin, rule }).input
  const active = input
    ? requiresActivationReview(input)
    : values.enabled && Number(values.needText) > 0
  const problem = input
    ? activationReviewProblem(
        input,
        preview?.review ?? null,
        reviewedInput ? ruleReviewKey(reviewedInput, rule?.id) : '',
        ruleReviewKey(input, rule?.id),
        acks,
        now,
      )
    : 'changed'

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
      abort.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!preview) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [preview])
  useEffect(() => {
    if (view === 'review') reviewHeading.current?.focus()
  }, [view])
  useEffect(() => {
    if (error) errorMessage.current?.focus()
  }, [error])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function clearReview() {
    epoch.current++
    abort.current?.abort()
    setPreview(null)
    setReviewedInput(null)
    setAcks({ wildcard: false, acceptAll: false })
    setStatus('idle')
  }
  function change<K extends keyof RuleFormValues>(field: K, value: RuleFormValues[K]) {
    clearReview()
    setValues((current) => ({ ...current, [field]: value }))
    setErrors({})
    setError('')
  }
  function validate() {
    const result = buildRuleInput(values, { isAdmin, rule })
    setErrors(result.errors)
    if (!result.input) {
      const first = Object.keys(result.errors)[0]
      requestAnimationFrame(() =>
        form.current?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus(),
      )
    }
    return result.input
  }
  function close() {
    if (!dirty && !savePending.current) {
      onOpenChange(false)
      return
    }
    if (view !== 'discard') previousView.current = view
    if (!savePending.current) {
      epoch.current++
      abort.current?.abort()
      setStatus('idle')
    }
    setView('discard')
  }
  async function inspect() {
    const next = validate()
    if (!next || savePending.current) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    const request = ++epoch.current
    setStatus('previewing')
    setError('')
    setAcks({ wildcard: false, acceptAll: false })
    try {
      const result = await rulesApi.preview(next, {
        ruleId: rule?.id,
        limit: 200,
        sampleLimit: 8,
        signal: controller.signal,
      })
      if (disposed.current || controller.signal.aborted || request !== epoch.current) return
      const acceptAll = result.review.acceptAll
      if (!isAdmin && rule && rule.accept_all !== acceptAll) {
        // Only the server-owned mode is refreshed; keep the operator's edits
        // and the opening progress snapshot used by partial disabled saves.
        setRule({ ...rule, accept_all: acceptAll })
        setValues((current) => ({ ...current, acceptAll }))
        initial.current = JSON.stringify({ ...initialRuleValues(rule), acceptAll })
      }
      setPreview(result)
      setReviewedInput({ ...next, accept_all: acceptAll })
      setNow(Date.now())
      setView('review')
    } catch (cause) {
      if (disposed.current || request !== epoch.current) return
      setPreview(null)
      setReviewedInput(null)
      setError(
        `ตรวจผลไม่สำเร็จ กรุณาลองอีกครั้ง: ${cause instanceof Error ? cause.message : 'การเชื่อมต่อขัดข้อง'}`,
      )
    } finally {
      if (!disposed.current && request === epoch.current) setStatus('idle')
    }
  }
  async function save() {
    const next = validate()
    if (!next || savePending.current) return
    const blocked = activationReviewProblem(
      next,
      preview?.review ?? null,
      reviewedInput ? ruleReviewKey(reviewedInput, rule?.id) : '',
      ruleReviewKey(next, rule?.id),
      acks,
      Date.now(),
    )
    if (blocked) {
      setNow(Date.now())
      setError('กรุณาตรวจผลกฎล่าสุดและยืนยันขอบเขตก่อนบันทึก')
      return
    }
    const payload: RuleInput = {
      ...next,
      ...(requiresActivationReview(next) && preview
        ? {
            activationReview: {
              token: preview.review.token,
              acknowledgeWildcard: acks.wildcard,
              acknowledgeAcceptAll: acks.acceptAll,
            },
          }
        : {}),
    }
    savePending.current = true
    setStatus('saving')
    setError('')
    try {
      if (rule)
        await rulesApi.update(
          rule.id,
          next.enabled === false ? disabledRulePatch(next, rule) : payload,
        )
      else await rulesApi.create(payload)
      await queryClient.invalidateQueries({ queryKey: ['rules'] })
      if (!disposed.current) {
        toast.success('บันทึกรายการสำเร็จ')
        onOpenChange(false)
      }
    } catch (cause) {
      if (disposed.current) return
      const message = cause instanceof Error ? cause.message : 'การเชื่อมต่อขัดข้อง'
      if (message.includes('RULE_REVIEW_')) {
        setPreview(null)
        setReviewedInput(null)
        setAcks({ wildcard: false, acceptAll: false })
        setView('form')
        setError('กฎหรือผลตรวจเปลี่ยนไป กรุณาตรวจผลอีกครั้งก่อนเปิดใช้งาน')
      } else {
        setError(
          `ยังยืนยันการบันทึกไม่ได้ ข้อมูลที่กรอกยังอยู่ ตรวจสอบรายการก่อนลองบันทึกซ้ำ: ${message}`,
        )
        void queryClient.invalidateQueries({ queryKey: ['rules'] })
      }
    } finally {
      savePending.current = false
      if (!disposed.current) setStatus('idle')
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (view === 'form' && active) void inspect()
    else void save()
  }
  const fieldError = (field: keyof RuleFormErrors) =>
    errors[field] ? (
      <p id={`rule-${field}-error`} className="text-xs text-danger">
        {errors[field]}
      </p>
    ) : null
  const fieldProps = (field: keyof RuleFormErrors) => ({
    'data-field': field,
    'aria-invalid': !!errors[field],
    'aria-describedby': errors[field] ? `rule-${field}-error` : undefined,
  })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        closeLabel="ปิดหน้าต่าง"
        onEscapeKeyDown={(event) => {
          // Radix handles Escape during capture; allow the open vehicle menu to consume it first.
          if (form.current?.querySelector('#rule-vehicle[aria-expanded="true"]'))
            event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (opener?.isConnected) opener.focus()
        }}
        className="max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] overflow-y-auto p-4 sm:max-w-[640px] sm:p-6"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="pr-7 text-left">
          <DialogTitle>
            {view === 'discard'
              ? 'ออกจากรายการนี้?'
              : rule
                ? 'แก้ไขรายการค้นหา'
                : 'เพิ่มรายการค้นหาใหม่'}
          </DialogTitle>
          <DialogDescription>
            {view === 'discard'
              ? 'ข้อมูลที่ยังไม่บันทึกจะหายไปเมื่อปิดหน้าต่าง'
              : 'กำหนดเงื่อนไข แล้วตรวจผลก่อนเปิดรับงานอัตโนมัติ'}
          </DialogDescription>
        </DialogHeader>
        {view === 'discard' ? (
          <div className="space-y-4">
            {status === 'saving' && (
              <p role="status" className="text-sm text-warning">
                กำลังส่งคำขอบันทึก การปิดหน้าต่างไม่ยกเลิกคำขอ กรุณาตรวจสอบรายการหลังจากปิด
              </p>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setView(previousView.current)}>
                กลับไปทำต่อ
              </Button>
              <Button onClick={() => onOpenChange(false)}>ออกจากหน้าต่าง</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            ref={form}
            onSubmit={submit}
            noValidate
            className="min-w-0 space-y-4"
            aria-busy={busy}
          >
            {error && (
              <p
                ref={errorMessage}
                tabIndex={-1}
                role="alert"
                className="break-words rounded-xl border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] p-3 text-sm"
              >
                {error}
              </p>
            )}
            {view === 'form' ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="rule-name">ชื่อรายการ</Label>
                  <Input
                    id="rule-name"
                    autoFocus
                    value={values.name}
                    onChange={(e) => change('name', e.target.value)}
                    disabled={busy}
                    maxLength={128}
                    {...fieldProps('name')}
                  />
                  {fieldError('name')}
                </div>
                {isAdmin && !rule ? (
                  <div className="space-y-2">
                    <Label htmlFor="rule-team">ทีมเจ้าของรายการ</Label>
                    <select
                      id="rule-team"
                      value={values.teamId}
                      onChange={(e) =>
                        change('teamId', e.target.value ? Number(e.target.value) : '')
                      }
                      disabled={busy || teams.isLoading}
                      {...fieldProps('teamId')}
                      className="min-h-11 w-full rounded-xl border border-white/10 bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                    >
                      <option value="">เลือกทีม</option>
                      {teams.data?.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                    {fieldError('teamId')}
                    {teams.isError && (
                      <div role="alert" className="text-sm text-danger">
                        โหลดทีมไม่สำเร็จ{' '}
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void teams.refetch()}
                        >
                          ลองใหม่
                        </Button>
                      </div>
                    )}
                  </div>
                ) : rule?.teamName ? (
                  <p className="break-words text-sm text-muted-foreground">ทีม: {rule.teamName}</p>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor="rule-origins">ต้นทาง (คั่นด้วยลูกน้ำ)</Label>
                    <Input
                      id="rule-origins"
                      value={values.originsText}
                      onChange={(e) => change('originsText', e.target.value)}
                      disabled={busy}
                      {...fieldProps('originsText')}
                    />
                    {fieldError('originsText')}
                  </div>
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor="rule-destinations">ปลายทาง (คั่นด้วยลูกน้ำ)</Label>
                    <Input
                      id="rule-destinations"
                      value={values.destinationsText}
                      onChange={(e) => change('destinationsText', e.target.value)}
                      disabled={busy}
                      {...fieldProps('destinationsText')}
                    />
                    {fieldError('destinationsText')}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rule-vehicle">ประเภทรถ</Label>
                  <VehicleTypeMultiSelect
                    id="rule-vehicle"
                    value={values.vehicleTypes}
                    onChange={(value) => change('vehicleTypes', value)}
                    disabled={busy}
                  />
                  {fieldError('vehicleTypes')}
                  <p className="text-xs text-muted-foreground">
                    ต้นทาง ปลายทาง หรือประเภทรถที่เว้นว่าง หมายถึงเลือกทั้งหมดในช่องนั้น
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rule-need">
                    {rule ? 'จำนวนที่ยังต้องการ (คัน)' : 'จำนวนที่ต้องการ (คัน)'}
                  </Label>
                  <Input
                    id="rule-need"
                    inputMode="numeric"
                    value={values.needText}
                    onChange={(e) => change('needText', e.target.value)}
                    disabled={busy}
                    {...fieldProps('needText')}
                  />
                  {fieldError('needText')}
                  <p className="text-xs text-muted-foreground">
                    {values.acceptAll
                      ? 'จำนวนนี้เป็นเป้าหมาย โหมดรับทั้ง booking อาจรับเกินได้'
                      : 'รับเฉพาะรายการที่ตรงเงื่อนไข ตามจำนวนที่ยังต้องการ'}
                    {rule ? ' · ใส่ 0 เพื่อระบุว่าครบแล้ว' : ''}
                  </p>
                </div>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={values.enabled}
                    onChange={(e) => change('enabled', e.target.checked)}
                    disabled={busy}
                    className="h-5 w-5 shrink-0 accent-primary"
                  />
                  เปิดใช้งานรายการนี้
                </label>
                {!rule && !values.enabled && (
                  <p className="text-xs text-muted-foreground">
                    รายการใหม่เริ่มแบบปิดไว้ คุณสามารถตรวจผลและเปิดใช้งานภายหลัง
                  </p>
                )}
                {isAdmin ? (
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-white/10 p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={values.acceptAll}
                      onChange={(e) => change('acceptAll', e.target.checked)}
                      disabled={busy}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
                    />
                    <span>รับทั้ง booking แม้จำนวนคันเกินเป้าหมาย</span>
                  </label>
                ) : (
                  values.acceptAll && (
                    <p className="rounded-xl border border-[color:var(--color-warning-border)] p-3 text-sm text-warning">
                      ผู้ดูแลตั้งให้รับทั้ง booking จำนวนคันอาจเกินเป้าหมายได้
                    </p>
                  )
                )}
              </div>
            ) : reviewedInput && preview ? (
              <div className="space-y-4">
                <h3 ref={reviewHeading} tabIndex={-1} className="font-semibold outline-none">
                  ตรวจขอบเขตก่อนบันทึก
                </h3>
                <p className="text-sm">
                  {active
                    ? 'เมื่อบันทึก รายการนี้จะเปิดรับงานอัตโนมัติ'
                    : input?.need === 0
                      ? 'เมื่อบันทึก รายการนี้จะมีสถานะครบแล้ว'
                      : 'เมื่อบันทึก รายการนี้จะยังปิดไว้'}
                </p>
                <RuleReviewSummary input={reviewedInput} preview={preview} />
                {active && preview.review.wildcardFields.length > 0 && (
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={acks.wildcard}
                      onChange={(e) =>
                        setAcks((current) => ({ ...current, wildcard: e.target.checked }))
                      }
                      disabled={busy}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
                    />
                    <span>
                      ยืนยันว่าไม่จำกัด
                      {preview.review.wildcardFields.map((field) => scopeLabels[field]).join(' / ')}
                    </span>
                  </label>
                )}
                {active && preview.review.acceptAll && (
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-warning-border)] p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={acks.acceptAll}
                      onChange={(e) =>
                        setAcks((current) => ({ ...current, acceptAll: e.target.checked }))
                      }
                      disabled={busy}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
                    />
                    <span>ยืนยันให้รับทั้ง booking แม้เกินเป้าหมาย {input?.need} คัน</span>
                  </label>
                )}
                {active && (
                  <p
                    role="status"
                    className={`text-xs ${problem === 'expired' ? 'text-danger' : 'text-muted-foreground'}`}
                  >
                    {problem === 'expired'
                      ? 'ผลตรวจหมดอายุ กรุณาตรวจอีกครั้ง'
                      : 'ผลตรวจใช้ยืนยันได้ 5 นาที หากแก้ไขกฎต้องตรวจใหม่'}
                  </p>
                )}
              </div>
            ) : null}
            <DialogFooter className="gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={
                  view === 'review'
                    ? () => {
                        clearReview()
                        setView('form')
                      }
                    : close
                }
                disabled={busy && view === 'review'}
              >
                {view === 'review' ? 'กลับไปแก้ไข' : 'ยกเลิก'}
              </Button>
              {((view === 'form' && !active) ||
                (view === 'review' && (problem === 'expired' || problem === 'missing'))) && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void inspect()}
                  disabled={busy}
                >
                  {status === 'previewing' ? 'กำลังตรวจผล…' : 'ตรวจผลกฎ'}
                </Button>
              )}
              <Button type="submit" disabled={busy || (view === 'review' && active && !!problem)}>
                {status === 'saving'
                  ? 'กำลังบันทึก…'
                  : status === 'previewing'
                    ? 'กำลังตรวจผล…'
                    : view === 'form' && active
                      ? 'ตรวจผลก่อนเปิดใช้งาน'
                      : active
                        ? 'ยืนยันและเปิดใช้งาน'
                        : rule
                          ? 'บันทึกการแก้ไข'
                          : 'สร้างรายการแบบปิดไว้'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
