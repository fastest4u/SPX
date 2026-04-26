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
    LINE_NOTIFY_TOKEN: '',
    DISCORD_WEBHOOK_URL: '',
  })

  useEffect(() => {
    if (settings) {
      setFormData({
        API_URL: settings.API_URL || '',
        POLL_INTERVAL_MS: settings.POLL_INTERVAL_MS || '30000',
        COOKIE: settings.COOKIE || '',
        DEVICE_ID: settings.DEVICE_ID || '',
        LINE_NOTIFY_TOKEN: settings.LINE_NOTIFY_TOKEN || '',
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
        <CardContent className="py-12 text-center text-muted-foreground">
          กำลังโหลด...
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white">ตั้งค่าระบบ</CardTitle>
          <p className="text-sm text-muted-foreground">
            ค่า secret จะแสดงแบบ masked หากไม่เปลี่ยนจะไม่เขียนทับค่าเดิม
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Alert */}
            <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-200">
                การบันทึกการตั้งค่าจะทำให้เซิร์ฟเวอร์รีสตาร์ทโดยอัตโนมัติ โปรดตรวจสอบค่าก่อนบันทึก
              </div>
            </div>

            {/* API Settings */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-white">API Settings</h3>
              
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">SPX API URL</label>
                <Input
                  value={formData.API_URL}
                  onChange={(e) => setFormData({ ...formData, API_URL: e.target.value })}
                  className="bg-white/5 border-white/10"
                  placeholder="https://..."
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">POLL_INTERVAL_MS</label>
                <Input
                  value={formData.POLL_INTERVAL_MS}
                  onChange={(e) => setFormData({ ...formData, POLL_INTERVAL_MS: e.target.value })}
                  className="bg-white/5 border-white/10"
                  placeholder="30000"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">Cookie</label>
                <textarea
                  value={formData.COOKIE}
                  onChange={(e) => setFormData({ ...formData, COOKIE: e.target.value })}
                  className="w-full h-24 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="fms_user_id=..."
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">Device ID</label>
                <Input
                  value={formData.DEVICE_ID}
                  onChange={(e) => setFormData({ ...formData, DEVICE_ID: e.target.value })}
                  className="bg-white/5 border-white/10"
                />
              </div>
            </div>

            <div className="border-t border-white/10 pt-6 space-y-4">
              <h3 className="text-sm font-medium text-white">Notification Settings</h3>
              
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">LINE Notify Token</label>
                <Input
                  value={formData.LINE_NOTIFY_TOKEN}
                  onChange={(e) => setFormData({ ...formData, LINE_NOTIFY_TOKEN: e.target.value })}
                  className="bg-white/5 border-white/10"
                  placeholder="********xxxx"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">Discord Webhook URL</label>
                <Input
                  value={formData.DISCORD_WEBHOOK_URL}
                  onChange={(e) => setFormData({ ...formData, DISCORD_WEBHOOK_URL: e.target.value })}
                  className="bg-white/5 border-white/10"
                  placeholder="https://discord.com/api/webhooks/..."
                />
              </div>
            </div>

            <Button
              type="submit"
              className="w-full bg-cyan-500 hover:bg-cyan-600"
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
