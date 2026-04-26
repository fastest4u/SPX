import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { notificationsApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { toast } from 'sonner'
import { Bell, Send, Eye } from 'lucide-react'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notifications',
  component: NotificationsComponent,
})

function NotificationsComponent() {
  const [preview, setPreview] = useState<unknown>(null)
  const [testResult, setTestResult] = useState<unknown>(null)

  const previewMutation = useMutation({
    mutationFn: notificationsApi.preview,
    onSuccess: (data) => {
      setPreview(data)
      toast.success('โหลด preview สำเร็จ')
    },
    onError: (error) => {
      toast.error('เกิดข้อผิดพลาด: ' + error.message)
    },
  })

  const testMutation = useMutation({
    mutationFn: notificationsApi.test,
    onSuccess: (data) => {
      setTestResult(data)
      toast.success('ส่งข้อความทดสอบสำเร็จ')
    },
    onError: (error) => {
      toast.error('เกิดข้อผิดพลาด: ' + error.message)
    },
  })

  return (
    <div className="space-y-5 sm:space-y-6">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white">Notification Preview / Test</CardTitle>
          <p className="text-sm text-muted-foreground">
            ตรวจสอบและทดสอบการแจ้งเตือน
          </p>
        </CardHeader>
        <CardContent className="space-y-5 sm:space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              variant="outline"
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
              className="w-full"
            >
              <Eye className="h-4 w-4 mr-2" />
              {previewMutation.isPending ? 'กำลังโหลด...' : 'Preview'}
            </Button>
            <Button
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
              className="w-full bg-gradient-to-r from-emerald-400 to-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20 hover:from-emerald-300 hover:to-cyan-300"
            >
              <Send className="h-4 w-4 mr-2" />
              {testMutation.isPending ? 'กำลังส่ง...' : 'Send Test'}
            </Button>
          </div>

          {!!preview && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-white">Preview</h4>
              <pre className="max-h-[50dvh] overflow-auto rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-xs leading-6 text-slate-300 sm:text-sm">
                {String(JSON.stringify(preview, null, 2))}
              </pre>
            </div>
          )}

          {!!testResult && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-white">Test Result</h4>
              <pre className="max-h-[50dvh] overflow-auto rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-xs leading-6 text-slate-300 sm:text-sm">
                {String(JSON.stringify(testResult, null, 2))}
              </pre>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-center gap-2 mb-2">
              <Bell className="h-4 w-4 text-cyan-300" />
              <span className="text-sm font-medium text-white">การตั้งค่าการแจ้งเตือน</span>
            </div>
            <p className="text-sm text-muted-foreground">
              การแจ้งเตือนจะถูกส่งผ่าน LINE Notify และ/หรือ Discord Webhook ตามการตั้งค่าใน Settings
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
