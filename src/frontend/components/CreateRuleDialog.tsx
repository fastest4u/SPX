import { RuleEditorDialog } from './RuleEditorDialog'

export function CreateRuleDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <RuleEditorDialog {...props} />
}
