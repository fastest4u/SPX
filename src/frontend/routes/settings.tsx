import { useState, useEffect } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { settingsApi, lineBotApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { toast } from 'sonner'
import { Save, AlertTriangle, MessageCircle, QrCode, CheckCircle2, XCircle, Loader2, Send } from 'lucide-react'
import type { LineBotStatus } from '../types'
import { QRCodeSVG } from 'qrcode.react'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsComponent,
})

function SettingsComponent() {
  const queryClient = useQueryClient()

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
  })

  const [formData, setFormData] = useState({
    API_URL: '',
    POLL_INTERVAL_MS: '30000',
    COOKIE: '',
    DEVICE_ID: '',
    LINE_CHANNEL_ACCESS_TOKEN: '',
    LINE_USER_ID: '',
    LINEJS_TEST_ENABLED: 'false',
    LINEJS_TEST_TARGET_ID: '',
    LINEJS_TEST_DEVICE: 'IOSIPAD',
    LINEJS_TEST_STORAGE_PATH: 'data/linejs-storage.json',
    DISCORD_WEBHOOK_URL: '',
    BOOKING_DETAIL_CONCURRENCY: '8',
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
    onError: (error) => {
      toast.error('เกิดข้อผิดพลาด: ' + error.message)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    updateMutation.mutate(formData)
  }

  if (isLoading) {
    return (
      <Card className="glass border-white/10">
        <CardContent className="py-14 text-center text-muted-foreground">
          กำลังโหลด...
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white">ตั้งค่าระบบ</CardTitle>
          <p className="text-sm text-muted-foreground">
            ค่า secret จะแสดงแบบ masked หากไม่เปลี่ยนจะไม่เขียนทับค่าเดิม
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="flex items-start gap-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4">
              <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-200">
                การบันทึกการตั้งค่าจะทำให้เซิร์ฟเวอร์รีสตาร์ทโดยอัตโนมัติ โปรดตรวจสอบค่าก่อนบันทึก
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                <h3 className="mb-4 text-sm font-black uppercase tracking-[0.16em] text-white">API Settings</h3>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label htmlFor="settings-api-url" className="text-sm text-muted-foreground">SPX API URL</label>
                    <Input
                      id="settings-api-url"
                      value={formData.API_URL}
                      onChange={(e) => setFormData({ ...formData, API_URL: e.target.value })}
                      placeholder="https://..."
                    />
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="settings-poll-interval" className="text-sm text-muted-foreground">POLL_INTERVAL_MS</label>
                    <Input
                      id="settings-poll-interval"
                      value={formData.POLL_INTERVAL_MS}
                      onChange={(e) => setFormData({ ...formData, POLL_INTERVAL_MS: e.target.value })}
                      placeholder="30000"
                    />
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="settings-booking-concurrency" className="text-sm text-muted-foreground">BOOKING_DETAIL_CONCURRENCY</label>
                    <Input
                      id="settings-booking-concurrency"
                      value={formData.BOOKING_DETAIL_CONCURRENCY}
                      onChange={(e) => setFormData({ ...formData, BOOKING_DETAIL_CONCURRENCY: e.target.value })}
                      placeholder="8"
                    />
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="settings-cookie" className="text-sm text-muted-foreground">Cookie</label>
                    <textarea
                      id="settings-cookie"
                      value={formData.COOKIE}
                      onChange={(e) => setFormData({ ...formData, COOKIE: e.target.value })}
                      className="min-h-28 w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-3 text-base text-white placeholder:text-muted-foreground transition-all duration-200 hover:border-white/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-sm"
                      placeholder="fms_user_id=..."
                    />
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="settings-device-id" className="text-sm text-muted-foreground">Device ID</label>
                    <Input
                      id="settings-device-id"
                      value={formData.DEVICE_ID}
                      onChange={(e) => setFormData({ ...formData, DEVICE_ID: e.target.value })}
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
                <h3 className="mb-4 text-sm font-black uppercase tracking-[0.16em] text-white">Notification Settings</h3>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label htmlFor="settings-line-token" className="text-sm text-muted-foreground">LINE Channel Access Token</label>
                    <Input
                      id="settings-line-token"
                      value={formData.LINE_CHANNEL_ACCESS_TOKEN}
                      onChange={(e) => setFormData({ ...formData, LINE_CHANNEL_ACCESS_TOKEN: e.target.value })}
                      placeholder="********xxxx"
                    />
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="settings-line-user-id" className="text-sm text-muted-foreground">LINE User/Group ID</label>
                    <Input
                      id="settings-line-user-id"
                      value={formData.LINE_USER_ID}
                      onChange={(e) => setFormData({ ...formData, LINE_USER_ID: e.target.value })}
                      placeholder="Uxxx... หรือ Cxxx..."
                    />
                    <p className="text-xs text-muted-foreground/60">เพิ่มบอทเข้ากลุ่มแล้วใช้ Group ID (ขึ้นต้นด้วย C)</p>
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="settings-discord-webhook" className="text-sm text-muted-foreground">Discord Webhook URL</label>
                    <Input
                      id="settings-discord-webhook"
                      value={formData.DISCORD_WEBHOOK_URL}
                      onChange={(e) => setFormData({ ...formData, DISCORD_WEBHOOK_URL: e.target.value })}
                      placeholder="https://discord.com/api/webhooks/..."
                    />
                  </div>
                </div>
              </section>
            </div>

            <Button
              type="submit"
              className="w-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20 hover:from-emerald-300 hover:to-cyan-300"
              disabled={updateMutation.isPending}
            >
              <Save className="h-4 w-4 mr-2" />
              {updateMutation.isPending ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* LINE Bot — standalone card with QR login */}
      <LineBotSettingsCard
        formData={formData}
        setFormData={setFormData}
        onSaveSettings={() => updateMutation.mutate(formData)}
        isSaving={updateMutation.isPending}
      />
    </div>
  )
}

// ── LINE Bot Settings + QR Login Card ──────────────────────────────────

interface LineBotSettingsCardProps {
  formData: {
    LINEJS_TEST_ENABLED: string
    LINEJS_TEST_TARGET_ID: string
    LINEJS_TEST_DEVICE: string
    LINEJS_TEST_STORAGE_PATH: string
    LINE_USER_ID: string
  }
  setFormData: (fn: (prev: any) => any) => void
  onSaveSettings: () => void
  isSaving: boolean
}

function LineBotSettingsCard({ formData, setFormData, onSaveSettings, isSaving }: LineBotSettingsCardProps) {
  const [testMid, setTestMid] = useState('')
  const [testMsg, setTestMsg] = useState('')

  // Poll status (auto-refresh every 3s when waiting for QR scan)
  const statusQuery = useQuery({
    queryKey: ['line-bot-status'],
    queryFn: lineBotApi.status,
    refetchInterval: (query) => {
      const data = query.state.data as LineBotStatus | undefined
      // Fast poll when waiting for QR scan, slow otherwise
      if (data?.enabled && !data.authenticated) return 3000
      return 15000
    },
  })

  const status = statusQuery.data
  const isServerEnabled = status?.enabled === true
  const isAuthenticated = status?.authenticated === true
  // Show QR button if user toggled dropdown to true, even before saving
  const isEnabledInForm = formData.LINEJS_TEST_ENABLED === 'true'
  const showQrLogin = (isServerEnabled || isEnabledInForm) && !isAuthenticated
  const needsSaveFirst = isEnabledInForm && !isServerEnabled

  const groupsQuery = useQuery({
    queryKey: ['line-bot-groups'],
    queryFn: lineBotApi.getGroups,
    enabled: isAuthenticated,
  })

  // Profile query
  const profileQuery = useQuery({
    queryKey: ['line-bot-profile'],
    queryFn: lineBotApi.getProfile,
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  })

  // Storage health query
  const storageQuery = useQuery({
    queryKey: ['line-bot-storage'],
    queryFn: lineBotApi.getStorage,
    enabled: isAuthenticated,
    refetchInterval: 10000,
  })

  // Login mutation
  const loginMutation = useMutation({
    mutationFn: lineBotApi.login,
    onSuccess: (data) => {
      statusQuery.refetch()
      if (data.authenticated) {
        toast.success('LINE Bot เชื่อมต่อสำเร็จ!')
      } else if (data.qrUrl) {
        toast.info('สแกน QR Code ด้านล่างด้วยแอป LINE')
      }
    },
    onError: (error) => {
      toast.error('Login error: ' + error.message)
    },
  })

  // Send test message mutation
  const sendMutation = useMutation({
    mutationFn: lineBotApi.send,
    onSuccess: () => {
      toast.success('ส่งข้อความสำเร็จ!')
      setTestMsg('')
    },
    onError: (error) => {
      toast.error('ส่งไม่สำเร็จ: ' + error.message)
    },
  })

  // Logout mutation
  const lineBotQueryClient = useQueryClient()
  const logoutMutation = useMutation({
    mutationFn: (clearStorage: boolean) => lineBotApi.logout(clearStorage),
    onSuccess: () => {
      toast.success('ออกจากระบบ LINE Bot แล้ว')
      lineBotQueryClient.invalidateQueries({ queryKey: ['line-bot-status'] })
      lineBotQueryClient.invalidateQueries({ queryKey: ['line-bot-profile'] })
      lineBotQueryClient.invalidateQueries({ queryKey: ['line-bot-groups'] })
      lineBotQueryClient.invalidateQueries({ queryKey: ['line-bot-storage'] })
    },
    onError: (error) => {
      toast.error('Logout ไม่สำเร็จ: ' + error.message)
    },
  })

  const qrUrl = loginMutation.data?.qrUrl || status?.qrUrl
  const pincode = loginMutation.data?.pincode || status?.pincode

  const handleSetFormField = (key: string, value: string) => {
    setFormData((prev: any) => ({ ...prev, [key]: value }))
  }

  return (
    <Card className="border-[#06C755]/20 bg-[#06C755]/[0.02]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-white">
          <MessageCircle className="h-5 w-5 text-[#06C755]" />
          LINE Bot (LINEJS)
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          login QR ครั้งเดียว ส่งข้อความผ่าน LINE ส่วนตัวได้ตลอด
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Connection Status Bar */}
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          {isAuthenticated ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
          ) : isEnabledInForm ? (
            <QrCode className="h-5 w-5 text-amber-400 shrink-0" />
          ) : (
            <XCircle className="h-5 w-5 text-rose-400/50 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white">
              {isAuthenticated ? '✅ เชื่อมต่อแล้ว — พร้อมส่งข้อความ' : isEnabledInForm ? '⏳ พร้อม Login — กดปุ่มด้านล่าง' : '⬛ ปิดใช้งาน'}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {isAuthenticated ? status?.message : isEnabledInForm && needsSaveFirst ? 'กดบันทึกก่อน แล้วจึง Login QR' : status?.message || 'กำลังตรวจสอบ...'}
            </div>
          </div>
        </div>

        {/* Profile & Storage Health */}
        {isAuthenticated && (
          <div className="space-y-3">
            {/* Profile */}
            {profileQuery.data && (
              <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4">
                <div className="h-10 w-10 rounded-full bg-[#06C755]/20 flex items-center justify-center text-lg shrink-0">
                  👤
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{profileQuery.data.displayName}</div>
                  <div className="text-[11px] text-slate-400 font-mono truncate">{profileQuery.data.mid}</div>
                  {profileQuery.data.statusMessage && (
                    <div className="text-xs text-slate-400 truncate">{profileQuery.data.statusMessage}</div>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 shrink-0 h-8 px-2"
                  onClick={() => {
                    if (window.confirm('ต้องการออกจากระบบ LINE Bot?\n\nเลือก "ตกลง" เพื่อ logout อย่างเดียว\nเลือก "ยกเลิก" แล้วกดปุ่ม "ล้างข้อมูลทั้งหมด" ด้านล่างหากต้องการล้างข้อมูลจัดเก็บ')) {
                      logoutMutation.mutate(false)
                    }
                  }}
                  disabled={logoutMutation.isPending}
                >
                  {logoutMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Logout'}
                </Button>
              </div>
            )}

            {/* Storage Health */}
            {storageQuery.data && (
              <div className="grid grid-cols-2 gap-2">
                <div className={`rounded-xl border p-2.5 text-center ${storageQuery.data.hasE2EEKeys ? 'border-emerald-500/20 bg-emerald-500/[0.05]' : 'border-amber-500/20 bg-amber-500/[0.05]'}`}>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">E2EE Keys</div>
                  <div className={`text-xs font-semibold mt-0.5 ${storageQuery.data.hasE2EEKeys ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {storageQuery.data.hasE2EEKeys ? '✅ มี' : '⚠️ ไม่มี'}
                  </div>
                </div>
                <div className={`rounded-xl border p-2.5 text-center ${storageQuery.data.hasAuthState ? 'border-emerald-500/20 bg-emerald-500/[0.05]' : 'border-amber-500/20 bg-amber-500/[0.05]'}`}>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Auth State</div>
                  <div className={`text-xs font-semibold mt-0.5 ${storageQuery.data.hasAuthState ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {storageQuery.data.hasAuthState ? '✅ มี' : '⚠️ ไม่มี'}
                  </div>
                </div>
              </div>
            )}

            {/* Storage warning */}
            {storageQuery.data && !storageQuery.data.hasE2EEKeys && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-xs text-amber-200">
                ⚠️ <strong>E2EE Keys หาย</strong> — หาก restart เซิร์ฟเวอร์ อาจต้อง login QR ใหม่
                {storageQuery.data.sizeBytes < 100 && (
                  <span> (ไฟล์ storage มีแค่ {storageQuery.data.sizeBytes} bytes)</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Notification Routing Info */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">เส้นทางการส่งข้อความ</h4>
          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-3 rounded-xl border border-[#06C755]/10 bg-[#06C755]/[0.03] p-3">
              <span className="shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#06C755]/20 text-[#06C755]">Rule match</span>
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium">LINEJS only</div>
                <div className="text-xs text-slate-400 truncate">ส่งตรงไปกลุ่ม {formData.LINEJS_TEST_TARGET_ID || formData.LINE_USER_ID || 'c05959fbfd088274cfe9e7dfe019dc858'}</div>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-blue-500/10 bg-blue-500/[0.03] p-3">
              <span className="shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">Auto-accept สำเร็จ</span>
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium">LINE OA → LINEJS fallback</div>
                <div className="text-xs text-slate-400">ลอง LINE OA ก่อน ถ้าติด quota/ล้มเหลว ส่ง LINEJS</div>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-rose-500/10 bg-rose-500/[0.03] p-3">
              <span className="shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400">Auto-accept ล้มเหลว</span>
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium">LINEJS only</div>
                <div className="text-xs text-slate-400 truncate">ส่งตรงไปกลุ่ม {formData.LINEJS_TEST_TARGET_ID || formData.LINE_USER_ID || 'c05959fbfd088274cfe9e7dfe019dc858'}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Settings Fields */}
        <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <label htmlFor="settings-linejs-enabled" className="text-sm text-muted-foreground">เปิดใช้งาน LINE Bot</label>
            </div>
            <select
              id="settings-linejs-enabled"
              value={formData.LINEJS_TEST_ENABLED}
              onChange={(e) => handleSetFormField('LINEJS_TEST_ENABLED', e.target.value)}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="false" className="bg-slate-900">false</option>
              <option value="true" className="bg-slate-900">true</option>
            </select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="settings-linejs-target" className="text-sm text-muted-foreground">Target MID</label>
              <span className="text-xs text-muted-foreground/70">ปล่อยว่างเพื่อใช้ ID เดียวกับ LINE OA ด้านบน</span>
            </div>
            <Input
              id="settings-linejs-target"
              value={formData.LINEJS_TEST_TARGET_ID}
              onChange={(e) => handleSetFormField('LINEJS_TEST_TARGET_ID', e.target.value)}
              placeholder={`Uxxx... หรือ Cxxx... (ค่าเริ่มต้น: ${formData.LINE_USER_ID || 'LINE_USER_ID'})`}
            />
            {isAuthenticated && groupsQuery.data?.chats && groupsQuery.data.chats.length > 0 && (
              <div className="mt-2 text-sm text-slate-300 bg-white/5 rounded-lg p-2 border border-white/10">
                <p className="mb-2 text-xs text-emerald-400">✅ พบกลุ่มที่คุณเป็นสมาชิก สามารถคลิกเลือกเพื่อเติมลงในช่องได้ทันที:</p>
                <div className="space-y-1 max-h-[150px] overflow-y-auto pr-2">
                  {groupsQuery.data.chats.map((chat) => (
                    <button
                      key={chat.chatMid}
                      type="button"
                      onClick={() => handleSetFormField('LINEJS_TEST_TARGET_ID', chat.chatMid)}
                      className="w-full text-left px-2 py-1.5 rounded bg-white/5 hover:bg-emerald-500/20 text-xs transition-colors flex justify-between items-center group"
                    >
                      <span className="truncate mr-2 text-slate-200 group-hover:text-emerald-300 font-medium">{chat.chatName || 'ไม่ทราบชื่อ'}</span>
                      <span className="text-[10px] text-slate-500 group-hover:text-emerald-400 shrink-0 font-mono">{chat.chatMid}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {isAuthenticated && groupsQuery.isLoading && (
              <div className="text-xs text-slate-400 mt-1 flex items-center">
                <Loader2 className="w-3 h-3 mr-1 animate-spin" /> กำลังโหลดรายชื่อกลุ่ม...
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="settings-linejs-device" className="text-sm text-muted-foreground">Device Type</label>
              <Input
                id="settings-linejs-device"
                value={formData.LINEJS_TEST_DEVICE}
                onChange={(e) => handleSetFormField('LINEJS_TEST_DEVICE', e.target.value)}
                placeholder="IOSIPAD"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="settings-linejs-storage" className="text-sm text-muted-foreground">Storage Path</label>
              <Input
                id="settings-linejs-storage"
                value={formData.LINEJS_TEST_STORAGE_PATH}
                onChange={(e) => handleSetFormField('LINEJS_TEST_STORAGE_PATH', e.target.value)}
                placeholder="data/linejs-storage.json"
              />
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={onSaveSettings}
            disabled={isSaving}
          >
            <Save className="h-4 w-4 mr-2" />
            {isSaving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า LINE Bot'}
          </Button>
        </div>

        {/* QR Login Section — visible when dropdown=true, even before saving */}
        {showQrLogin && (
          <div className="space-y-4">
            {needsSaveFirst && (
              <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-200">
                ⚠️ กรุณา <strong>บันทึกการตั้งค่า</strong> ด้านบนก่อน แล้วรอเซิร์ฟเวอร์ restart จึงจะ Login QR ได้
              </div>
            )}
            <Button
              type="button"
              onClick={() => {
                if (needsSaveFirst) {
                  toast.error('กรุณาบันทึกการตั้งค่าก่อน แล้วรอ restart')
                  return
                }
                loginMutation.mutate()
              }}
              disabled={loginMutation.isPending}
              className="w-full bg-[#06C755] hover:bg-[#05b34c] text-white font-medium shadow-lg shadow-[#06C755]/20"
            >
              {loginMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <QrCode className="h-4 w-4 mr-2" />
              )}
              {loginMutation.isPending ? 'กำลังสร้าง QR Code...' : 'Login ด้วย QR Code'}
            </Button>

            {/* QR URL + PIN display */}
            {qrUrl && (
              <div className="rounded-2xl border border-[#06C755]/30 bg-[#06C755]/10 p-5 space-y-4 flex flex-col items-center text-center">
                <div className="flex items-center gap-2 w-full justify-center">
                  <QrCode className="h-5 w-5 text-[#06C755]" />
                  <span className="font-medium text-white">สแกน QR Code เพื่อ Login</span>
                </div>

                <div className="bg-white p-4 rounded-xl shadow-lg">
                  <QRCodeSVG value={qrUrl} size={200} level="H" includeMargin={true} />
                </div>

                <div className="text-sm text-slate-300 space-y-2 max-w-sm">
                  <p>1. สแกน QR Code ด้านบนด้วยแอป LINE</p>
                  <p className="text-xs text-slate-400 break-all">(หรือเปิดลิงก์: <a href={qrUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">{qrUrl}</a>)</p>
                </div>

                {pincode && (
                  <div className="text-sm text-slate-300 w-full pt-2 border-t border-white/10">
                    <p>2. กรอก PIN ในแอป LINE:</p>
                    <div className="mt-2 inline-block rounded-lg bg-white/10 px-5 py-3 font-mono text-3xl font-bold text-white tracking-[0.4em] shadow-inner">
                      {pincode}
                    </div>
                  </div>
                )}

                <p className="text-xs text-[#06C755]/80 font-medium pt-2">
                  รอสักครู่หลังกรอก PIN ระบบจะเชื่อมต่ออัตโนมัติ
                </p>
              </div>
            )}
          </div>
        )}

        {/* Authenticated — Quick Send Test */}
        {isAuthenticated && (
          <div className="space-y-3 rounded-2xl border border-emerald-300/20 bg-emerald-300/5 p-4">
            <h4 className="text-sm font-medium text-white">ทดสอบส่งข้อความ</h4>
            <div className="space-y-2">
              <Input
                value={testMid}
                onChange={(e) => setTestMid(e.target.value)}
                placeholder="Target MID (uxxx... / cxxx...)"
              />
              <textarea
                value={testMsg}
                onChange={(e) => setTestMsg(e.target.value)}
                placeholder="ข้อความ..."
                rows={2}
                className="w-full rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm text-white placeholder:text-muted-foreground focus:border-[#06C755]/50 focus:outline-none focus:ring-1 focus:ring-[#06C755]/30 transition-colors resize-none"
              />
            </div>
            <Button
              type="button"
              onClick={() => {
                if (!testMid.trim() || !testMsg.trim()) {
                  toast.error('กรุณากรอก MID และข้อความ')
                  return
                }
                sendMutation.mutate({ to: testMid.trim(), text: testMsg.trim() })
              }}
              disabled={sendMutation.isPending || !testMid.trim() || !testMsg.trim()}
              className="w-full bg-[#06C755] hover:bg-[#05b34c] text-white"
            >
              {sendMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              {sendMutation.isPending ? 'กำลังส่ง...' : 'ส่งข้อความทดสอบ'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
