import { createFileRoute } from '@tanstack/react-router'
import { useSettingsForm, type SettingsForm } from '../lib/settings-shared'
import { SettingsLineBotSection } from '../components/SettingsLineBotSection'

export const Route = createFileRoute('/settings/line-bot')({
  component: SettingsLineBotRoute,
})

function SettingsLineBotRoute() {
  const { formData, setField, save, isSaving } = useSettingsForm()
  // Adapt the typed setField (keyof SettingsForm) to the loose
  // (string, string) signature SettingsLineBotSection expects.
  const setFieldLoose = (key: string, value: string) => {
    setField(key as keyof SettingsForm, value)
  }
  return (
    <SettingsLineBotSection
      formData={formData}
      setField={setFieldLoose}
      onSave={save}
      isSaving={isSaving}
    />
  )
}
