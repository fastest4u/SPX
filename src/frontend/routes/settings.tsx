import { useState, useEffect } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { settingsApi } from '../lib/api'
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
      toast.success('บันทึกการตั้งค่าแล้ว เซิร์ฟเวอร์กำลังรีสตาร์ท...')
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

  const pollMs = Number(formData.POLL_INTERVAL_MS || 30000)
  const pollSeconds = Number.isFinite(pollMs) ? Math.max(0, Math.round(pollMs / 1000)) : 0
  const apiReady = Boolean(formData.API_URL.trim() && formData.DEVICE_ID.trim() && formData.COOKIE.trim())
  const configuredChannels = [
    formData.LINE_CHANNEL_ACCESS_TOKEN,
    formData.DISCORD_WEBHOOK_URL,
    formData.LINEJS_TEST_ENABLED === 'true' ? 'LINEJS' : '',
  ].filter(value => String(value).trim()).length
  const settingsSummary = [
    { label: 'SPX API', value: apiReady ? 'พร้อมใช้งาน' : 'รอค่า', tone: apiReady ? 'good' : 'warn' },
    { label: 'Polling', value: pollSeconds ? `${pollSeconds}s` : '—', tone: 'info' },
    { label: 'Notify', value: `${configuredChannels}/3 ช่องทาง`, tone: configuredChannels > 0 ? 'good' : 'muted' },
    { label: 'Storage', value: 'MySQL', tone: 'gold' },
  ] as const

  if (isLoading) {
    return (
      <div className="settings-loading">
        <div className="settings-loading-card">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">กำลังโหลดการตั้งค่า...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-page mx-auto max-w-7xl">
      {/* Page Header */}
      <div className="settings-hero mb-6">
        <div className="settings-hero-orb settings-hero-orb-a" />
        <div className="settings-hero-orb settings-hero-orb-b" />
        <div className="settings-hero-grid">
          <div className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="settings-hero-badge"><Database className="h-3.5 w-3.5" /> DB-backed settings</span>
              <span className="settings-hero-badge"><ShieldCheck className="h-3.5 w-3.5" /> Masked secrets</span>
              <span className="settings-hero-badge"><Clock className="h-3.5 w-3.5" /> Restart after save</span>
            </div>
            <div className="flex items-start gap-4">
              <div className="settings-hero-icon">
                <Settings2 className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <h1 className="settings-title">ตั้งค่าระบบ</h1>
                <p className="settings-subtitle">จัดการ API, notification และ LINE Bot จากหน้าจอเดียว พร้อมโครงสร้างที่อ่านง่ายบนมือถือ แท็บเล็ต และเดสก์ท็อป</p>
              </div>
            </div>
          </div>
          <div className="settings-summary-grid">
            {settingsSummary.map(item => (
              <div key={item.label} className="settings-summary-card" data-tone={item.tone}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        {/* Warning banner */}
        <div className="settings-warning mb-5">
          <div className="settings-warning-icon">
            <AlertTriangle className="h-4 w-4 text-amber-300" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-amber-100">การบันทึกการตั้งค่าจะทำให้เซิร์ฟเวอร์รีสตาร์ทโดยอัตโนมัติ</div>
            <p className="mt-1 text-xs leading-relaxed text-amber-100/70">ค่า secret ที่ถูก masked จะไม่เขียนทับค่าเดิม หากต้องการเปลี่ยนให้กรอกค่าใหม่เต็มรูปแบบ</p>
          </div>
        </div>

        {/* Tab + Content layout */}
        <div className="flex flex-col lg:flex-row gap-5 lg:gap-6">
          {/* Tab nav — horizontal scroll on mobile, vertical sidebar on desktop */}
          <nav className="settings-nav-shell">
            {TABS.map(tab => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  type="button"
                  className="settings-tab"
                  data-active={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="settings-tab-icon">
                    <Icon className="h-4 w-4 shrink-0" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{tab.label}</span>
                    <span className="settings-tab-description">{tab.description}</span>
                  </span>
                </button>
              )
            })}

            {/* Save button in sidebar on desktop */}
            <div className="hidden lg:block mt-3 pt-3 border-t border-white/10">
              <div className="mb-3 rounded-2xl border border-white/10 bg-black/15 p-3">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-white">
                  <Lock className="h-3.5 w-3.5 text-primary" />
                  Secure update
                </div>
                <p className="text-[0.7rem] leading-relaxed text-muted-foreground">บันทึกเฉพาะค่าที่แก้ไขและคงค่า secret เดิมเมื่อยังเป็น masked</p>
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-emerald-300 via-cyan-300 to-sky-300 text-slate-950 shadow-xl shadow-cyan-500/20 hover:from-emerald-200 hover:to-sky-200 text-xs h-11 rounded-2xl"
                disabled={updateMutation.isPending}
              >
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {updateMutation.isPending ? 'กำลังบันทึก...' : 'บันทึก'}
              </Button>
            </div>
          </nav>

          {/* Content area */}
          <div className="flex-1 min-w-0">
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

        {/* Floating save button on mobile */}
        <div className="settings-mobile-save lg:hidden">
          <Button
            type="submit"
            className="w-full bg-gradient-to-r from-emerald-300 via-cyan-300 to-sky-300 text-slate-950 shadow-xl shadow-cyan-500/25 hover:from-emerald-200 hover:to-sky-200 rounded-2xl"
            disabled={updateMutation.isPending}
          >
            <Save className="h-4 w-4 mr-2" />
            {updateMutation.isPending ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
          </Button>
        </div>
        {/* Spacer for fixed bottom bar on mobile */}
        <div className="lg:hidden h-24" />
      </form>
    </div>
  )
}

/* ─── API & Polling Section ──────────────────────── */
function ApiSection({ formData, setField }: { formData: Record<string, string>; setField: (k: string, v: string) => void }) {
  const pollMs = Number(formData.POLL_INTERVAL_MS || 30000)
  const intervalSec = Number.isFinite(pollMs) ? Math.max(0, Math.round(pollMs / 1000)) : 0
  const concurrency = Number(formData.BOOKING_DETAIL_CONCURRENCY || 0)

  return (
    <div className="settings-section space-y-5">
      {/* Polling overview card */}
      <div className="settings-card settings-card-cyan">
        <div className="settings-card-header">
          <div className="settings-card-icon">
            <Gauge className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="settings-card-eyebrow">Automation</p>
            <h3 className="settings-card-title">Polling Configuration</h3>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="settings-field">
            <div className="settings-label-row">
              <label htmlFor="s-poll">Poll Interval</label>
              <span className="settings-inline-badge">≈ {intervalSec || '—'}s</span>
            </div>
            <div className="relative">
              <Input id="s-poll" value={formData.POLL_INTERVAL_MS} onChange={e => setField('POLL_INTERVAL_MS', e.target.value)} placeholder="30000" inputMode="numeric" className="settings-input pr-20" />
            </div>
            <span className="field-hint">ความถี่ในการเช็คงานใหม่ (มิลลิวินาที)</span>
          </div>
          <div className="settings-field">
            <div className="settings-label-row">
              <label htmlFor="s-concurrency">Concurrency</label>
              <span className="settings-inline-badge">{Number.isFinite(concurrency) && concurrency > 0 ? `${concurrency} jobs` : '—'}</span>
            </div>
            <Input id="s-concurrency" value={formData.BOOKING_DETAIL_CONCURRENCY} onChange={e => setField('BOOKING_DETAIL_CONCURRENCY', e.target.value)} placeholder="8" inputMode="numeric" className="settings-input" />
            <span className="field-hint">จำนวน request ดึงรายละเอียดงานพร้อมกัน</span>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="settings-metric" data-tone="info">
            <Clock className="h-4 w-4" />
            <div>
              <span>รอบเช็คงาน</span>
              <strong>{intervalSec ? `${intervalSec}s` : '—'}</strong>
            </div>
          </div>
          <div className="settings-metric" data-tone="gold">
            <Activity className="h-4 w-4" />
            <div>
              <span>Parallel load</span>
              <strong>{Number.isFinite(concurrency) && concurrency > 0 ? `${concurrency}` : '—'}</strong>
            </div>
          </div>
          <div className="settings-metric" data-tone="good">
            <Database className="h-4 w-4" />
            <div>
              <span>Config source</span>
              <strong>app_settings</strong>
            </div>
          </div>
        </div>
      </div>

      {/* API credentials */}
      <div className="settings-card settings-card-gold">
        <div className="settings-card-header">
          <div className="settings-card-icon">
            <KeyRound className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="settings-card-eyebrow">SPX Access</p>
            <h3 className="settings-card-title">API Credentials</h3>
          </div>
        </div>
        <div className="space-y-4">
          <div className="settings-field">
            <label htmlFor="s-api-url">SPX API URL</label>
            <Input id="s-api-url" value={formData.API_URL} onChange={e => setField('API_URL', e.target.value)} placeholder="https://..." className="settings-input" />
            <span className="field-hint">URL สำหรับเรียก booking/bidding/list</span>
          </div>
          <div className="settings-field">
            <label htmlFor="s-cookie">Cookie</label>
            <textarea
              id="s-cookie"
              value={formData.COOKIE}
              onChange={e => setField('COOKIE', e.target.value)}
              className="settings-textarea"
              placeholder="fms_user_id=..."
            />
            <span className="field-hint">Session cookie จาก SPX — ค่าจะ masked ถ้าไม่เปลี่ยนจะไม่ถูกเขียนทับ</span>
          </div>
          <div className="settings-field">
            <label htmlFor="s-device-id">Device ID</label>
            <Input id="s-device-id" value={formData.DEVICE_ID} onChange={e => setField('DEVICE_ID', e.target.value)} placeholder="device-uuid" className="settings-input" />
            <span className="field-hint">อุปกรณ์ที่ผูกกับ session ปัจจุบัน</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─── Notification Section ───────────────────────── */
function NotifySection({ formData, setField }: { formData: Record<string, string>; setField: (k: string, v: string) => void }) {
  return (
    <div className="settings-section space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        {/* LINE OA */}
        <div className="settings-card settings-card-green">
          <div className="settings-card-header">
            <div className="settings-card-icon">
              <MessageCircle className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="settings-card-eyebrow">LINE Messaging API</p>
              <h3 className="settings-card-title">LINE Official Account</h3>
            </div>
          </div>
          <div className="space-y-4">
            <div className="settings-field">
              <label htmlFor="s-line-token">Channel Access Token</label>
              <Input id="s-line-token" value={formData.LINE_CHANNEL_ACCESS_TOKEN} onChange={e => setField('LINE_CHANNEL_ACCESS_TOKEN', e.target.value)} placeholder="********xxxx" className="settings-input" />
              <span className="field-hint">Token สำหรับส่ง Push Message ผ่าน LINE Messaging API</span>
            </div>
            <div className="settings-field">
              <label htmlFor="s-line-uid">User / Group ID</label>
              <Input id="s-line-uid" value={formData.LINE_USER_ID} onChange={e => setField('LINE_USER_ID', e.target.value)} placeholder="Uxxx... หรือ Cxxx..." className="settings-input" />
              <span className="field-hint">เพิ่มบอทเข้ากลุ่มแล้วใช้ Group ID (ขึ้นต้นด้วย C)</span>
            </div>
          </div>
        </div>

        {/* Discord */}
        <div className="settings-card settings-card-violet">
          <div className="settings-card-header">
            <div className="settings-card-icon">
              <Bell className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="settings-card-eyebrow">Webhook Channel</p>
              <h3 className="settings-card-title">Discord</h3>
            </div>
          </div>
          <div className="settings-field">
            <label htmlFor="s-discord">Webhook URL</label>
            <Input id="s-discord" value={formData.DISCORD_WEBHOOK_URL} onChange={e => setField('DISCORD_WEBHOOK_URL', e.target.value)} placeholder="https://discord.com/api/webhooks/..." className="settings-input" />
            <span className="field-hint">สร้าง Webhook ในช่อง Discord ที่ต้องการรับแจ้งเตือน</span>
          </div>
        </div>
      </div>
      <div className="settings-callout">
        <div className="settings-callout-icon">
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
