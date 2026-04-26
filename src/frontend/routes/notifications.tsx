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
    <div className="space-y-6">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white">Notification Preview / Test</CardTitle>
          <p className="text-sm text-muted-foreground">
            ตรวจสอบและทดสอบการแจ้งเตือน
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
            >
              <Eye className="h-4 w-4 mr-2" />
              {previewMutation.isPending ? 'กำลังโหลด...' : 'Preview'}
            </Button>
            <Button
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
              className="bg-cyan-500 hover:bg-cyan-600"
            >
              <Send className="h-4 w-4 mr-2" />
              {testMutation.isPending ? 'กำลังส่ง...' : 'Send Test'}
            </Button>
          </div>

          {/* Preview Result */}
          {!!preview && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-white">Preview</h4>
              <pre className="p-4 rounded-lg bg-white/5 border border-white/10 text-sm text-muted-foreground overflow-auto">
                {String(JSON.stringify(preview, null, 2))}
              </pre>
            </div>
          )}

          {/* Test Result */}
          {!!testResult && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-white">Test Result</h4>
              <pre className="p-4 rounded-lg bg-white/5 border border-white/10 text-sm text-muted-foreground overflow-auto">
                {String(JSON.stringify(testResult, null, 2))}
              </pre>
            </div>
          )}

          {/* Info */}
          <div className="p-4 rounded-lg bg-white/5 border border-white/10">
            <div className="flex items-center gap-2 mb-2">
              <Bell className="h-4 w-4 text-cyan-400" />
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
