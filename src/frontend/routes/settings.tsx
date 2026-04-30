import { useState, useEffect } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery, useMutation } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { settingsApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { toast } from 'sonner'
import { Save, AlertTriangle } from 'lucide-react'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsComponent,
})

function SettingsComponent() {
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
    DISCORD_WEBHOOK_URL: '',
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
        DISCORD_WEBHOOK_URL: settings.DISCORD_WEBHOOK_URL || '',
      })
    }
  }, [settings])

  const updateMutation = useMutation({
    mutationFn: settingsApi.update,
    onSuccess: () => {
      toast.success('บันทึกการตั้งค่าแล้ว เซิร์ฟเวอร์กำลังรีสตาร์ท...')
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
    <div className="mx-auto max-w-5xl">
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
    </div>
  )
}
