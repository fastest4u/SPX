import type { NotifyRule, RuleInput, RulePatch } from '../types'
import { splitCsv } from './utils'

export function disabledRulePatch(input: RuleInput, original: NotifyRule): RulePatch {
  const patch: RulePatch = { name: input.name, enabled: false }
  for (const field of ['origins', 'destinations', 'vehicle_types'] as const) {
    if (JSON.stringify(input[field]) !== JSON.stringify(original[field]))
      patch[field] = input[field]
  }
  if (input.accept_all !== original.accept_all) patch.accept_all = input.accept_all
  if (input.need !== original.need) {
    patch.need = input.need
    patch.fulfilled = input.need === 0
    patch.auto_accepted = input.need === 0
  }
  return patch
}

export interface RuleFormValues {
  name: string
  originsText: string
  destinationsText: string
  vehicleTypes: string[]
  needText: string
  enabled: boolean
  acceptAll: boolean
  teamId: number | ''
}

export type RuleFormErrors = Partial<
  Record<
    'name' | 'originsText' | 'destinationsText' | 'vehicleTypes' | 'needText' | 'teamId',
    string
  >
>

export function initialRuleValues(rule?: NotifyRule | null): RuleFormValues {
  return {
    name: rule?.name ?? '',
    originsText: rule?.origins.join(', ') ?? '',
    destinationsText: rule?.destinations.join(', ') ?? '',
    vehicleTypes: [...(rule?.vehicle_types ?? [])],
    needText: String(rule?.need ?? 1),
    enabled: rule?.enabled ?? false,
    acceptAll: rule?.accept_all ?? false,
    teamId: rule?.teamId ?? '',
  }
}

export function buildRuleInput(
  values: RuleFormValues,
  context: { isAdmin: boolean; rule?: NotifyRule | null },
): { input?: RuleInput; errors: RuleFormErrors } {
  const errors: RuleFormErrors = {}
  const name = values.name.trim()
  if (!name || name.length > 128) errors.name = 'กรอกชื่อรายการ 1–128 ตัวอักษร'
  const needText = values.needText.trim()
  const need = Number(needText)
  if (
    !/^\d+$/.test(needText) ||
    !Number.isSafeInteger(need) ||
    need < (context.rule ? 0 : 1) ||
    need > 1000
  ) {
    errors.needText = `กรอกจำนวนเต็ม ${context.rule ? '0' : '1'}–1,000 คัน`
  }
  const teamId = context.rule?.teamId ?? values.teamId
  if (context.isAdmin && (typeof teamId !== 'number' || teamId < 1))
    errors.teamId = 'เลือกทีมเจ้าของรายการ'
  const origins = splitCsv(values.originsText)
  const destinations = splitCsv(values.destinationsText)
  if (origins.length > 200 || origins.some((value) => value.length > 255))
    errors.originsText = 'ระบุไม่เกิน 200 ต้นทาง และแต่ละค่าไม่เกิน 255 ตัวอักษร'
  if (destinations.length > 200 || destinations.some((value) => value.length > 255))
    errors.destinationsText = 'ระบุไม่เกิน 200 ปลายทาง และแต่ละค่าไม่เกิน 255 ตัวอักษร'
  if (values.vehicleTypes.length > 200 || values.vehicleTypes.some((value) => value.length > 100))
    errors.vehicleTypes = 'ระบุไม่เกิน 200 ประเภทรถ และแต่ละค่าไม่เกิน 100 ตัวอักษร'
  if (Object.keys(errors).length) return { errors }
  return {
    errors,
    input: {
      ...(typeof teamId === 'number' ? { teamId } : {}),
      name,
      origins,
      destinations,
      vehicle_types: [...values.vehicleTypes],
      need,
      enabled: values.enabled,
      accept_all: context.isAdmin ? values.acceptAll : context.rule?.accept_all === true,
      fulfilled: need === 0,
      auto_accepted: need === 0,
    },
  }
}

export function ruleReviewKey(input: RuleInput, ruleId?: string): string {
  return JSON.stringify({
    ruleId: ruleId ?? null,
    teamId: input.teamId ?? null,
    name: input.name,
    origins: input.origins,
    destinations: input.destinations,
    vehicle_types: input.vehicle_types,
    need: input.need,
    enabled: input.enabled,
    accept_all: input.accept_all,
    fulfilled: input.fulfilled,
    auto_accepted: input.auto_accepted,
  })
}

export function requiresActivationReview(input: RuleInput): boolean {
  return input.enabled === true && input.need > 0 && input.fulfilled !== true
}

export type ReviewProblem = 'missing' | 'changed' | 'expired' | 'wildcard' | 'accept-all'

export function activationReviewProblem(
  input: RuleInput,
  review: {
    token: string
    expiresAt: string
    wildcardFields: readonly string[]
    acceptAll: boolean
  } | null,
  reviewedKey: string,
  currentKey: string,
  acknowledgements: { wildcard: boolean; acceptAll: boolean },
  now = Date.now(),
): ReviewProblem | null {
  if (!requiresActivationReview(input)) return null
  if (!review?.token) return 'missing'
  if (reviewedKey !== currentKey || review.acceptAll !== (input.accept_all === true))
    return 'changed'
  const expiresAt = Date.parse(review.expiresAt)
  if (!Number.isFinite(expiresAt) || now >= expiresAt) return 'expired'
  if (review.wildcardFields.length && !acknowledgements.wildcard) return 'wildcard'
  if (review.acceptAll && !acknowledgements.acceptAll) return 'accept-all'
  return null
}
