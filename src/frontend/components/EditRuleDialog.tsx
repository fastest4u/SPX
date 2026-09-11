import type { NotifyRule } from '../types'
import { RuleEditorDialog } from './RuleEditorDialog'

export function EditRuleDialog(props: {
  rule: NotifyRule | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return props.rule ? <RuleEditorDialog {...props} /> : null
}
