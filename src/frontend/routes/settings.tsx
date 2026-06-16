import { Link, Outlet, createFileRoute, redirect, useRouterState } from '@tanstack/react-router'
import { BellRing, MessageCircle, RotateCcw, Save, Settings2, Wifi } from 'lucide-react'
import { Button } from '../components/ui/button'
import { PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { SettingsFormProvider, useSettingsForm } from '../lib/settings-shared'
import { cn } from '../lib/utils'

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
    <PageShell bottomSafe>
      <PageHeader
        icon={Settings2}
        title="ตั้งค่าระบบ"
        subtitle={subtitle}
        meta={<DirtyIndicator />}
        actions={<DesktopSaveButton />}
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[16rem_minmax(0,1fr)]">
        <SettingsSectionRail path={path} />
        <section className="min-w-0 space-y-4" aria-label="Settings detail">
          <Outlet />
        </section>
      </div>

      <MobileSaveBar />
    </PageShell>
  )
}

const settingsSections = [
  {
    to: '/settings/api',
    label: 'API & Polling',
    description: 'SPX endpoint, polling, AI provider',
    icon: Wifi,
  },
  {
    to: '/settings/notifications',
    label: 'การแจ้งเตือน',
    description: 'LINE OA และ Discord',
    icon: BellRing,
  },
  {
    to: '/settings/line-bot',
    label: 'LINE Bot',
    description: 'QR login, target, storage',
    icon: MessageCircle,
  },
] as const

function SettingsSectionRail({ path }: { path: string }) {
  const { isDirty, reset, isSaving } = useSettingsForm()

  return (
    <aside className="min-w-0 max-w-full overflow-hidden xl:sticky xl:top-4 xl:self-start" aria-label="Settings sections">
      <div className="min-w-0 rounded-[8px] border border-white/[0.06] bg-card/70 p-2 shadow-none">
        <nav className="flex flex-wrap gap-1 xl:flex-col">
          {settingsSections.map((item) => {
            const Icon = item.icon
            const active = path === item.to || path.startsWith(`${item.to}/`)
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex min-w-0 flex-1 basis-[10rem] items-center gap-3 rounded-[8px] border px-3 py-2.5 text-left transition-colors xl:flex-none xl:basis-auto',
                  active
                    ? 'border-primary/20 bg-primary/[0.08] text-primary'
                    : 'border-transparent text-muted-foreground hover:border-white/[0.08] hover:bg-white/[0.03] hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{item.label}</span>
                  <span className="hidden truncate text-xs text-muted-foreground xl:block">
                    {item.description}
                  </span>
                </span>
              </Link>
            )
          })}
        </nav>

        <div className="mt-2 hidden rounded-[8px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 xl:block">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">
              {isDirty ? 'มีการเปลี่ยนแปลง' : 'บันทึกแล้ว'}
            </span>
            <span className={cn('h-2 w-2 rounded-full', isDirty ? 'bg-primary' : 'bg-success')} />
          </div>
          {isDirty ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 h-8 w-full justify-start rounded-[8px] px-2 text-xs"
              onClick={reset}
              disabled={isSaving}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              ย้อนค่าที่แก้
            </Button>
          ) : null}
        </div>
      </div>
    </aside>
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
          <RotateCcw className="h-3.5 w-3.5" />
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
  const { isDirty, isSaving, save, reset } = useSettingsForm()
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
        {isDirty ? (
          <Button
            type="button"
            variant="ghost"
            className="h-10 px-3"
            onClick={reset}
            disabled={isSaving}
            aria-label="ย้อนค่าที่แก้"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : null}
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
