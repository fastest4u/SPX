import { createFileRoute } from '@tanstack/react-router'
import { ApiSection, useSettingsForm } from '../lib/settings-shared'

export const Route = createFileRoute('/settings/api')({
  component: SettingsApiRoute,
})

function SettingsApiRoute() {
  const { formData, setField } = useSettingsForm()
  return <ApiSection formData={formData} setField={setField} />
}
