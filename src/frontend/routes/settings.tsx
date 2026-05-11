import { useState, useEffect } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { settingsApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { toast } from 'sonner'
import { Save, AlertTriangle, Wifi, Bell, MessageCircle, Gauge, Settings2, ShieldCheck, Database, Clock, KeyRound, Activity, Bot, Lock } from 'lucide-react'
import { SettingsLineBotSection } from '../components/SettingsLineBotSection'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsComponent,
})

const TABS = [
  { id: 'api', label: 'API & Polling', description: 'Endpoint, cookie และรอบดึงงาน', icon: Wifi },
  { id: 'notify', label: 'การแจ้งเตือน', description: 'LINE OA และ Discord webhook', icon: Bell },
  { id: 'linebot', label: 'LINE Bot', description: 'QR login, routing และทดสอบส่ง', icon: MessageCircle },
] as const

type TabId = (typeof TABS)[number]['id']

function getIntervalSec(pollIntervalMs: string): number {
  const ms = Number(pollIntervalMs || 30000)
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0
}

const INITIAL_FORM = {
  API_URL: '',
  POLL_INTERVAL_MS: '30000',
  COOKIE: '',
  DEVICE_ID: '',
  LINE_CHANNEL_ACCESS_TOKEN: '',
  LINE_USER_ID: '',
  LINEJS_TEST_ENABLED: 'false',
  LINEJS_TEST_TARGET_ID: '',
  LINEJS_TEST_TARGET_ID_RULE_MATCH: '',
  LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: '',
  LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: '',
  LINEJS_TEST_DEVICE: 'IOSIPAD',
  LINEJS_TEST_STORAGE_PATH: 'data/linejs-storage.json',
  DISCORD_WEBHOOK_URL: '',
  BOOKING_DETAIL_CONCURRENCY: '8',
}

function SettingsComponent() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<TabId>('api')
  const [formData, setFormData] = useState(INITIAL_FORM)

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
  })

  useEffect(() => {
    if (settings) {
      setFormData({
        API_URL: settings.API_URL || '',
        POLL_INTERVAL_MS: settings.POLL_INTERVAL_MS || '30000',
        COOKIE: settings.COOKIE || '',
        DEVICE_ID: settings.DEVICE_ID || '',
        LINE_CHANNEL_ACCESS_TOKEN: settings.LINE_CHANNEL_ACCESS_TOKEN || '',
        LINE_USER_ID: settings.LINE_USER_ID || '',
        LINEJS_TEST_ENABLED: settings.LINEJS_TEST_ENABLED || 'false',
        LINEJS_TEST_TARGET_ID: settings.LINEJS_TEST_TARGET_ID || '',
        LINEJS_TEST_TARGET_ID_RULE_MATCH: settings.LINEJS_TEST_TARGET_ID_RULE_MATCH || '',
        LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS: settings.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS || '',
        LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE: settings.LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE || '',
        LINEJS_TEST_DEVICE: settings.LINEJS_TEST_DEVICE || 'IOSIPAD',
        LINEJS_TEST_STORAGE_PATH: settings.LINEJS_TEST_STORAGE_PATH || 'data/linejs-storage.json',
        DISCORD_WEBHOOK_URL: settings.DISCORD_WEBHOOK_URL || '',
        BOOKING_DETAIL_CONCURRENCY: settings.BOOKING_DETAIL_CONCURRENCY || '8',
      })
    }
  }, [settings])

  const updateMutation = useMutation({
    mutationFn: settingsApi.update,
    onSuccess: () => {
      toast.success('บันทึกการตั้งค่าแล้ว มีผลทันที')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['line-bot-status'] })
    },
    onError: (error) => toast.error('เกิดข้อผิดพลาด: ' + error.message),
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    updateMutation.mutate(formData)
  }

  const setField = (key: string, value: string) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }

  const pollSeconds = getIntervalSec(formData.POLL_INTERVAL_MS)
  const apiReady = Boolean(formData.API_URL.trim() && formData.DEVICE_ID.trim() && formData.COOKIE.trim())
  const configuredChannels = [
    formData.LINE_CHANNEL_ACCESS_TOKEN,
    formData.DISCORD_WEBHOOK_URL,
    formData.LINEJS_TEST_ENABLED === 'true' ? 'LINEJS' : '',
  ].filter(value => String(value).trim()).length
  const settingsSummary = [
    { label: 'SPX API', value: apiReady ? 'พร้อมใช้งาน' : 'รอค่า', tone: apiReady ? 'emerald' : 'amber' },
    { label: 'Polling', value: pollSeconds ? `${pollSeconds}s` : '—', tone: 'cyan' },
    { label: 'Notify', value: `${configuredChannels}/3 ช่องทาง`, tone: configuredChannels > 0 ? 'emerald' : 'slate' },
    { label: 'Storage', value: 'MySQL', tone: 'primary' },
  ] as const

  const toneColors: Record<string, string> = {
    emerald: 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200',
    amber: 'border-amber-300/20 bg-amber-300/10 text-amber-200',
    cyan: 'border-cyan-300/20 bg-cyan-300/10 text-cyan-200',
    slate: 'border-slate-300/20 bg-slate-300/10 text-slate-300',
    primary: 'border-primary/20 bg-primary/10 text-primary',
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">กำลังโหลดการตั้งค่า...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Header + Summary Card */}
      <Card className="glass border-white/10">
        <CardHeader className="gap-4 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[0.7rem] font-semibold text-muted-foreground">
              <Database className="h-3 w-3" /> DB-backed settings
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[0.7rem] font-semibold text-muted-foreground">
              <ShieldCheck className="h-3 w-3" /> Masked secrets
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[0.7rem] font-semibold text-muted-foreground">
              <Clock className="h-3 w-3" /> Live reload
            </span>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <Settings2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-white text-xl sm:text-2xl">ตั้งค่าระบบ</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
                จัดการ API, notification และ LINE Bot จากหน้าจอเดียว พร้อมโครงสร้างที่อ่านง่ายบนมือถือ แท็บเล็ต และเดสก์ท็อป
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {settingsSummary.map(item => (
              <div key={item.label} className={`rounded-xl border px-3 py-2.5 ${toneColors[item.tone] || toneColors.slate}`}>
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-60">{item.label}</div>
                <div className="mt-1 text-sm font-black tracking-tight font-mono">{item.value}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <form onSubmit={handleSubmit}>
        {/* Warning banner */}
        <div className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-300/10">
            <AlertTriangle className="h-4 w-4 text-amber-300" />
          </div>
          <div>
            <div className="text-sm font-semibold text-amber-100">การบันทึกการตั้งค่าจะมีผลทันที โดยไม่ต้องรีสตาร์ทเซิร์ฟเวอร์</div>
            <p className="mt-1 text-xs leading-relaxed text-amber-100/70">ค่า secret ที่ถูก masked จะไม่เขียนทับค่าเดิม หากต้องการเปลี่ยนให้กรอกค่าใหม่เต็มรูปแบบ</p>
          </div>
        </div>

        {/* Tab + Content layout */}
        <div className="flex flex-col lg:flex-row gap-5 lg:gap-6">
          {/* Tab nav */}
          <nav className="flex lg:flex-col gap-1.5 overflow-x-auto pb-2 lg:overflow-visible lg:sticky lg:top-4 lg:w-56 lg:shrink-0 lg:p-3 lg:rounded-2xl lg:border lg:border-white/10 lg:glass">
            {TABS.map(tab => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center lg:w-full gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 whitespace-nowrap shrink-0 text-left ${
                    isActive
                      ? 'bg-primary/10 text-primary border border-primary/20 shadow-[0_0_18px_-8px_var(--color-primary)]'
                      : 'text-muted-foreground hover:text-white hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="hidden sm:inline lg:inline truncate">{tab.label}</span>
                </button>
              )
            })}

            {/* Desktop save section */}
            <div className="hidden lg:block mt-2 pt-3 border-t border-white/10">
              <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-white">
                  <Lock className="h-3.5 w-3.5 text-primary" />
                  Secure update
                </div>
                <p className="text-[0.7rem] leading-relaxed text-muted-foreground">
                  บันทึกเฉพาะค่าที่แก้ไขและคงค่า secret เดิมเมื่อยังเป็น masked
                </p>
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20 hover:from-emerald-300 hover:to-cyan-300 text-xs h-11 rounded-xl"
                disabled={updateMutation.isPending}
              >
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {updateMutation.isPending ? 'กำลังบันทึก...' : 'บันทึก'}
              </Button>
            </div>
          </nav>

          {/* Content area */}
          <div className="flex-1 min-w-0 space-y-5">
            {activeTab === 'api' && <ApiSection formData={formData} setField={setField} />}
            {activeTab === 'notify' && <NotifySection formData={formData} setField={setField} />}
            {activeTab === 'linebot' && (
              <SettingsLineBotSection
                formData={formData}
                setField={setField}
                onSave={() => updateMutation.mutate(formData)}
                isSaving={updateMutation.isPending}
              />
            )}
          </div>
        </div>

        {/* Mobile floating save */}
        <div className="lg:hidden fixed inset-x-0 bottom-0 z-30 border-t border-white/10 glass p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <Button
            type="submit"
            className="w-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/25 hover:from-emerald-300 hover:to-cyan-300 rounded-xl h-11"
            disabled={updateMutation.isPending}
          >
            <Save className="h-4 w-4 mr-2" />
            {updateMutation.isPending ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
          </Button>
        </div>
        <div className="lg:hidden h-20" />
      </form>
    </div>
  )
}

function ApiSection({ formData, setField }: { formData: Record<string, string>; setField: (k: string, v: string) => void }) {
  const intervalSec = getIntervalSec(formData.POLL_INTERVAL_MS)
  const concurrency = Number(formData.BOOKING_DETAIL_CONCURRENCY || 0)

  return (
    <div className="space-y-5">
      {/* Polling Config */}
      <Card className="glass border-white/10">
        <CardHeader className="gap-3 pb-3 sm:flex-row sm:items-center">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10">
            <Gauge className="h-4 w-4 text-cyan-300" />
          </div>
          <div>
            <CardTitle className="text-white text-base">Polling Configuration</CardTitle>
            <p className="text-xs text-muted-foreground">Automation</p>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="s-poll" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Poll Interval</label>
                <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[0.65rem] font-bold text-muted-foreground font-mono">
                  ≈ {intervalSec || '—'}s
                </span>
              </div>
              <Input id="s-poll" value={formData.POLL_INTERVAL_MS} onChange={e => setField('POLL_INTERVAL_MS', e.target.value)} placeholder="30000" inputMode="numeric" />
              <p className="text-[0.7rem] text-muted-foreground/70">ความถี่ในการเช็คงานใหม่ (มิลลิวินาที)</p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="s-concurrency" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Concurrency</label>
                <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[0.65rem] font-bold text-muted-foreground font-mono">
                  {Number.isFinite(concurrency) && concurrency > 0 ? `${concurrency} jobs` : '—'}
                </span>
              </div>
              <Input id="s-concurrency" value={formData.BOOKING_DETAIL_CONCURRENCY} onChange={e => setField('BOOKING_DETAIL_CONCURRENCY', e.target.value)} placeholder="8" inputMode="numeric" />
              <p className="text-[0.7rem] text-muted-foreground/70">จำนวน request ดึงรายละเอียดงานพร้อมกัน</p>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <div className="flex items-center gap-2.5 rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2.5">
              <Clock className="h-4 w-4 shrink-0 text-cyan-300" />
              <div className="min-w-0">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-cyan-300/60">รอบเช็คงาน</div>
                <div className="text-sm font-black text-cyan-200 font-mono">{intervalSec ? `${intervalSec}s` : '—'}</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 rounded-xl border border-primary/20 bg-primary/10 px-3 py-2.5">
              <Activity className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-primary/60">Parallel load</div>
                <div className="text-sm font-black text-primary font-mono">{Number.isFinite(concurrency) && concurrency > 0 ? `${concurrency}` : '—'}</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2.5">
              <Database className="h-4 w-4 shrink-0 text-emerald-300" />
              <div className="min-w-0">
                <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] text-emerald-300/60">Config source</div>
                <div className="text-sm font-black text-emerald-200 font-mono">app_settings</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* API Credentials */}
      <Card className="glass border-white/10">
        <CardHeader className="gap-3 pb-3 sm:flex-row sm:items-center">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
            <KeyRound className="h-4 w-4 text-primary" />
          </div>
          <div>
            <CardTitle className="text-white text-base">API Credentials</CardTitle>
            <p className="text-xs text-muted-foreground">SPX Access</p>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="s-api-url" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">SPX API URL</label>
              <Input id="s-api-url" value={formData.API_URL} onChange={e => setField('API_URL', e.target.value)} placeholder="https://..." />
              <p className="text-[0.7rem] text-muted-foreground/70">URL สำหรับเรียก booking/bidding/list</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="s-cookie" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Cookie</label>
              <textarea
                id="s-cookie"
                value={formData.COOKIE}
                onChange={e => setField('COOKIE', e.target.value)}
                className="flex min-h-[7rem] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y"
                placeholder="fms_user_id=..."
              />
              <p className="text-[0.7rem] text-muted-foreground/70">Session cookie จาก SPX — ค่าจะ masked ถ้าไม่เปลี่ยนจะไม่ถูกเขียนทับ</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="s-device-id" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Device ID</label>
              <Input id="s-device-id" value={formData.DEVICE_ID} onChange={e => setField('DEVICE_ID', e.target.value)} placeholder="device-uuid" />
              <p className="text-[0.7rem] text-muted-foreground/70">อุปกรณ์ที่ผูกกับ session ปัจจุบัน</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function NotifySection({ formData, setField }: { formData: Record<string, string>; setField: (k: string, v: string) => void }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        {/* LINE OA */}
        <Card className="glass border-white/10">
          <CardHeader className="gap-3 pb-3 sm:flex-row sm:items-center">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-300/20 bg-emerald-300/10">
              <MessageCircle className="h-4 w-4 text-emerald-300" />
            </div>
            <div>
              <CardTitle className="text-white text-base">LINE Official Account</CardTitle>
              <p className="text-xs text-muted-foreground">LINE Messaging API</p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="s-line-token" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Channel Access Token</label>
                <Input id="s-line-token" value={formData.LINE_CHANNEL_ACCESS_TOKEN} onChange={e => setField('LINE_CHANNEL_ACCESS_TOKEN', e.target.value)} placeholder="********xxxx" />
                <p className="text-[0.7rem] text-muted-foreground/70">Token สำหรับส่ง Push Message ผ่าน LINE Messaging API</p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="s-line-uid" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">User / Group ID</label>
                <Input id="s-line-uid" value={formData.LINE_USER_ID} onChange={e => setField('LINE_USER_ID', e.target.value)} placeholder="Uxxx... หรือ Cxxx..." />
                <p className="text-[0.7rem] text-muted-foreground/70">เพิ่มบอทเข้ากลุ่มแล้วใช้ Group ID (ขึ้นต้นด้วย C)</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Discord */}
        <Card className="glass border-white/10">
          <CardHeader className="gap-3 pb-3 sm:flex-row sm:items-center">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-300/20 bg-violet-300/10">
              <Bell className="h-4 w-4 text-violet-300" />
            </div>
            <div>
              <CardTitle className="text-white text-base">Discord</CardTitle>
              <p className="text-xs text-muted-foreground">Webhook Channel</p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              <label htmlFor="s-discord" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Webhook URL</label>
              <Input id="s-discord" value={formData.DISCORD_WEBHOOK_URL} onChange={e => setField('DISCORD_WEBHOOK_URL', e.target.value)} placeholder="https://discord.com/api/webhooks/..." />
              <p className="text-[0.7rem] text-muted-foreground/70">สร้าง Webhook ในช่อง Discord ที่ต้องการรับแจ้งเตือน</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Callout */}
      <div className="flex items-start gap-3 rounded-2xl border border-accent/20 bg-accent/5 p-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent/10">
          <Bot className="h-4 w-4 text-accent" />
        </div>
        <div>
          <div className="text-sm font-semibold text-white">ต้องการ routing แบบละเอียด?</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">ไปที่แท็บ LINE Bot เพื่อกำหนดปลายทางแยกตาม rule match, auto-accept สำเร็จ และ auto-accept ล้มเหลว</p>
        </div>
      </div>
    </div>
  )
}
