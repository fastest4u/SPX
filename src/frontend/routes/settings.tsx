import { Outlet, createFileRoute, redirect, useRouterState } from '@tanstack/react-router'
import { Settings2, Save } from 'lucide-react'
import { Button } from '../components/ui/button'
import { PageHeader } from '../components/ui/page-header'
import { SettingsFormProvider, useSettingsForm } from '../lib/settings-shared'

export const Route = createFileRoute('/settings')({
  component: SettingsLayoutRoute,
  beforeLoad: ({ location }) => {
    // Redirect bare /settings to the first sub-route so the user lands on a
    // concrete section instead of a blank parent.
    if (location.pathname === '/settings' || location.pathname === '/settings/') {
      throw redirect({ to: '/settings/api' })
    }
  },
})

function SettingsLayoutRoute() {
  return (
    <SettingsFormProvider>
      <SettingsLayoutContent />
    </SettingsFormProvider>
  )
}

function SettingsLayoutContent() {
  const router = useRouterState()
  const path = router.location.pathname
  const subtitle = pathSubtitle(path)
  return (
    <div className="space-y-5 page-enter pb-24 lg:pb-0">
      <PageHeader
        icon={Settings2}
        title="ตั้งค่าระบบ"
        subtitle={subtitle}
        meta={<DirtyIndicator />}
        actions={<DesktopSaveButton />}
      />

      <Outlet />

      <MobileSaveBar />
    </div>
  )
}

function pathSubtitle(path: string): string {
  if (path.startsWith('/settings/api')) return 'API & Polling — เชื่อมต่อ SPX และตั้งรอบดึงงาน'
  if (path.startsWith('/settings/notifications')) return 'การแจ้งเตือน — LINE OA และ Discord webhook'
  if (path.startsWith('/settings/line-bot')) return 'LINE Bot — QR login และ routing'
  return 'API, การแจ้งเตือน, และ LINE Bot'
}

function DirtyIndicator() {
  const { isDirty } = useSettingsForm()
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
      <span
        className={`h-1.5 w-1.5 rounded-full ${isDirty ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40'
          }`}
        aria-hidden="true"
      />
      {isDirty ? 'มีการเปลี่ยนแปลง' : 'บันทึกแล้ว'}
    </span>
  )
}

function DesktopSaveButton() {
  const { isDirty, isSaving, save, reset } = useSettingsForm()
  return (
    <div className="hidden items-center gap-2 sm:flex">
      {isDirty ? (
        <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={isSaving}>
          ย้อน
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        onClick={save}
        disabled={!isDirty || isSaving}
      >
        <Save className="h-3.5 w-3.5" />
        {isSaving ? 'กำลังบันทึก...' : 'บันทึก'}
      </Button>
    </div>
  )
}

function MobileSaveBar() {
  const { isDirty, isSaving, save } = useSettingsForm()
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.08] bg-popover/95 px-4 py-3 backdrop-blur-md sm:hidden pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-2">
        <span className="inline-flex flex-1 items-center gap-1.5 text-xs">
          <span
            className={`h-1.5 w-1.5 rounded-full ${isDirty ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40'
              }`}
            aria-hidden="true"
          />
          <span className="text-muted-foreground">
            {isDirty ? 'มีการเปลี่ยนแปลง' : 'บันทึกแล้ว'}
          </span>
        </span>
        <Button
          type="button"
          className="h-10"
          onClick={save}
          disabled={!isDirty || isSaving}
        >
          <Save className="h-4 w-4" />
          {isSaving ? 'กำลังบันทึก...' : 'บันทึก'}
        </Button>
      </div>
    </div>
  )
}
