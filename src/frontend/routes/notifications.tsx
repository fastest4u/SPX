import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { notificationsApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { toast } from 'sonner'
import { SkeletonTable, SkeletonCard } from '../components/ui/skeleton'
import { Bell, Send, Eye } from 'lucide-react'
import type { NotificationPreview, NotificationTestResult } from '../types'

export const Route = createFileRoute('/notifications')({
  component: NotificationsComponent,
})

function NotificationsComponent() {
  const [preview, setPreview] = useState<NotificationPreview | null>(null)
  const [testResult, setTestResult] = useState<NotificationTestResult | null>(null)
  const lineJsQrChallenge = testResult?.channels.find((channel) => channel.channel === 'linejs_test' && channel.qrUrl)

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
      const lineJsQr = data.channels.find((channel) => channel.channel === 'linejs_test' && channel.qrUrl)
      if (lineJsQr?.qrUrl) {
        toast.info('LINEJS ต้องสแกน QR ก่อน แล้วกด Send Test อีกครั้ง')
      } else if (Object.values(data.sent).some(Boolean)) {
        toast.success('ส่งข้อความทดสอบสำเร็จ')
      } else {
        toast.error('ส่งข้อความทดสอบไม่สำเร็จ')
      }
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
              {!!lineJsQrChallenge?.qrUrl && (
                <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4 text-sm text-emerald-100">
                  <div className="font-medium text-white">LINEJS QR Login</div>
                  <a
                    href={lineJsQrChallenge.qrUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block break-all text-cyan-200 underline underline-offset-4"
                  >
                    {lineJsQrChallenge.qrUrl}
                  </a>
                  {!!lineJsQrChallenge.pincode && (
                    <div className="mt-2">PIN: <span className="font-mono text-white">{lineJsQrChallenge.pincode}</span></div>
                  )}
                  <div className="mt-2 text-xs text-emerald-100/70">เปิดลิงก์หรือสแกนด้วยแอป LINE แล้วกด Send Test อีกครั้ง</div>
                </div>
              )}
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
              การแจ้งเตือนจะถูกส่งผ่าน LINE OA, LINEJS test และ/หรือ Discord Webhook ตามการตั้งค่าใน Settings
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
