import { createFileRoute } from '@tanstack/react-router'
import { NotifySection, useSettingsForm } from '../lib/settings-shared'

export const Route = createFileRoute('/settings/notifications')({
    component: SettingsNotificationsRoute,
})

function SettingsNotificationsRoute() {
    const { formData, setField } = useSettingsForm()
    return <NotifySection formData={formData} setField={setField} />
}
