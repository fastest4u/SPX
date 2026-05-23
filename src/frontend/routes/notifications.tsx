import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { notificationsApi } from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { PageHeader } from '../components/ui/page-header'
import { toast } from 'sonner'
import { Bell, Send, Eye } from 'lucide-react'
import type { NotificationPreview, NotificationTestResult } from '../types'

export const Route = createFileRoute('/notifications')({
  component: NotificationsComponent,
})

function NotificationsComponent() {
  const [preview, setPreview] = useState<NotificationPreview | null>(null)
  const [testResult, setTestResult] = useState<NotificationTestResult | null>(null)
  const lineJsQrChallenge = testResult?.channels.find(
    (channel) => channel.channel === 'linejs_test' && channel.qrUrl
  )

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
      const lineJsQr = data.channels.find(
        (channel) => channel.channel === 'linejs_test' && channel.qrUrl
      )
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
    <div className="space-y-5 page-enter">
      <PageHeader
        icon={Bell}
        title="แจ้งเตือน"
        subtitle="ตรวจสอบและทดสอบการแจ้งเตือนจาก SPX"
      />

      <Card className="glass border-white/10">
        <CardContent className="space-y-5 p-5 sm:space-y-6 sm:p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              variant="outline"
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
              className="w-full"
            >
              <Eye className="h-4 w-4" />
              {previewMutation.isPending ? 'กำลังโหลด...' : 'Preview'}
            </Button>
            <Button
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
              className="w-full"
            >
              <Send className="h-4 w-4" />
              {testMutation.isPending ? 'กำลังส่ง...' : 'Send Test'}
            </Button>
          </div>

          {preview ? (
            <div className="space-y-2">
              <h4 className="section-title">Preview</h4>
              <pre className="max-h-[50dvh] overflow-auto rounded-xl border border-white/10 bg-white/[0.04] p-4 text-xs leading-6 text-muted-foreground sm:text-sm">
                {String(JSON.stringify(preview, null, 2))}
              </pre>
            </div>
          ) : null}

          {testResult ? (
            <div className="space-y-2">
              <h4 className="section-title">Test Result</h4>
              {lineJsQrChallenge?.qrUrl ? (
                <div className="rounded-xl border border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] p-4 text-sm">
                  <div className="font-medium text-foreground">LINEJS QR Login</div>
                  <a
                    href={lineJsQrChallenge.qrUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block break-all text-info underline underline-offset-4"
                  >
                    {lineJsQrChallenge.qrUrl}
                  </a>
                  {lineJsQrChallenge.pincode ? (
                    <div className="mt-2 text-muted-foreground">
                      PIN: <span className="font-data text-foreground">{lineJsQrChallenge.pincode}</span>
                    </div>
                  ) : null}
                  <div className="mt-2 text-xs text-muted-foreground">
                    เปิดลิงก์หรือสแกนด้วยแอป LINE แล้วกด Send Test อีกครั้ง
                  </div>
                </div>
              ) : null}
              <pre className="max-h-[50dvh] overflow-auto rounded-xl border border-white/10 bg-white/[0.04] p-4 text-xs leading-6 text-muted-foreground sm:text-sm">
                {String(JSON.stringify(testResult, null, 2))}
              </pre>
            </div>
          ) : null}

          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-2 flex items-center gap-2">
              <Bell className="h-4 w-4 text-info" />
              <span className="section-title">การตั้งค่าการแจ้งเตือน</span>
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
