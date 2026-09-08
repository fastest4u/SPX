import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { notificationsApi } from '../lib/api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Card, CardContent } from '../components/ui/card'
import { ContentSection, PageShell } from '../components/layout/Page'
import { PageHeader } from '../components/ui/page-header'
import { toast } from 'sonner'
import {
  Bell,
  Send,
  Eye,
  CheckCircle2,
  XCircle,
  Loader2,
  MessageSquare,
  QrCode,
  Code2,
} from 'lucide-react'
import type { NotificationPreview, NotificationTestResult } from '../types'
import { safeBrowserUrl } from '../lib/utils'
import { QRCodeSVG } from 'qrcode.react'

export const Route = createFileRoute('/notifications')({
  component: NotificationsComponent,
})

function NotificationsComponent() {
  const [preview, setPreview] = useState<NotificationPreview | null>(null)
  const [testResult, setTestResult] = useState<NotificationTestResult | null>(null)
  const lineJsQrChallenge = testResult?.channels.find(
    (channel) => channel.channel === 'linejs_test' && channel.qrUrl
  )
  const lineJsQrUrl = safeBrowserUrl(lineJsQrChallenge?.qrUrl, {
    allowedProtocols: ['http:', 'https:', 'line:'],
  })
  const lineJsQrPincode = lineJsQrChallenge?.pincode

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
    <PageShell>
      <PageHeader
        icon={Bell}
        title="แจ้งเตือน"
        subtitle="ตรวจสอบและทดสอบการแจ้งเตือนจาก SPX"
      />

      <ContentSection contentClassName="space-y-5 sm:space-y-6">
        {/* Action triggers */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Button
            variant="outline"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending}
            className="w-full"
          >
            {previewMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
            {previewMutation.isPending ? 'กำลังโหลด...' : 'Preview ข้อความ'}
          </Button>
          <Button
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending}
            className="w-full"
          >
            {testMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {testMutation.isPending ? 'กำลังส่ง...' : 'Send Test (ส่งข้อความทดสอบ)'}
          </Button>
        </div>

        {/* Formatted Preview Card */}
        {preview ? (
          <Card className="bg-card border-white/10 overflow-hidden">
            <div className="border-b border-white/[0.06] px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-info" />
                <h4 className="section-title">ตัวอย่างข้อความแจ้งเตือน (Preview)</h4>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge variant={preview.preview.channels.line ? 'success' : 'neutral'}>
                  LINE OA: {preview.preview.channels.line ? 'เปิด' : 'ปิด'}
                </Badge>
                <Badge variant={preview.preview.channels.discord ? 'success' : 'neutral'}>
                  Discord: {preview.preview.channels.discord ? 'เปิด' : 'ปิด'}
                </Badge>
                <Badge variant={preview.preview.channels.linejs_test ? 'success' : 'neutral'}>
                  LINEJS: {preview.preview.channels.linejs_test ? 'เปิด' : 'ปิด'}
                </Badge>
              </div>
            </div>
            <CardContent className="p-5 space-y-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground mb-1">หัวข้อ</div>
                <div className="text-sm font-semibold text-foreground">{preview.preview.title || 'ไม่มีหัวข้อ'}</div>
              </div>

              <div>
                <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground mb-1">เนื้อหาจำลอง</div>
                <div className="rounded-xl border border-white/[0.08] bg-black/20 p-4 text-xs font-mono leading-relaxed text-foreground whitespace-pre-wrap max-h-80 overflow-y-auto">
                  {preview.preview.message}
                </div>
              </div>

              <details className="text-xs text-muted-foreground pt-1 group">
                <summary className="cursor-pointer hover:text-foreground inline-flex items-center gap-1">
                  <Code2 className="h-3.5 w-3.5" />
                  <span>ดูข้อมูลเชิงลึก (Raw JSON)</span>
                </summary>
                <pre className="mt-2 max-h-52 overflow-auto rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[0.7rem] text-muted-foreground">
                  {JSON.stringify(preview, null, 2)}
                </pre>
              </details>
            </CardContent>
          </Card>
        ) : null}

        {/* Formatted Test Result Card */}
        {testResult ? (
          <Card className="bg-card border-white/10 overflow-hidden">
            <div className="border-b border-white/[0.06] px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Send className="h-4 w-4 text-primary" />
                <h4 className="section-title">ผลการทดสอบการส่ง (Test Result)</h4>
              </div>
              <Badge variant={testResult.ok ? 'success' : 'danger'}>
                {testResult.ok ? 'ส่งสำเร็จ' : 'มีข้อผิดพลาด'}
              </Badge>
            </div>
            <CardContent className="p-5 space-y-4">
              {testResult.message ? (
                <p className="text-sm text-muted-foreground">{testResult.message}</p>
              ) : null}

              {/* QR Challenge Display if LINEJS needs QR scan */}
              {lineJsQrUrl ? (
                <div className="flex flex-col items-center gap-4 rounded-2xl border border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] p-5 text-center">
                  <div className="flex items-center gap-2 text-foreground font-medium text-sm">
                    <QrCode className="h-5 w-5 text-success" />
                    <span>LINEJS ต้องการให้สแกน QR Code ก่อนส่ง</span>
                  </div>

                  <div className="rounded-xl bg-white p-4 shadow-xl">
                    <QRCodeSVG value={lineJsQrUrl} size={180} level="H" includeMargin />
                  </div>

                  <div className="text-xs text-muted-foreground space-y-1 max-w-md">
                    <p>สแกนด้วยแอป LINE บนมือถือ หรือเปิดลิงก์:</p>
                    <a
                      href={lineJsQrUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all rounded-lg bg-white/10 px-3 py-1.5 text-info underline underline-offset-4 hover:text-info transition-colors"
                    >
                      {lineJsQrUrl}
                    </a>
                  </div>

                  {lineJsQrPincode ? (
                    <div className="w-full pt-3 border-t border-white/10 text-sm text-foreground">
                      <p className="text-muted-foreground text-xs">PIN ยืนยันในแอป LINE:</p>
                      <div className="mt-1.5 inline-block rounded-xl bg-white/10 px-5 py-2 font-mono text-2xl font-bold text-foreground tracking-[0.3em] shadow-inner">
                        {lineJsQrPincode}
                      </div>
                    </div>
                  ) : null}

                  <p className="text-xs text-success/80">
                    หลังจากสแกนและยืนยันในแอป LINE แล้ว ให้กดปุ่ม Send Test อีกครั้ง
                  </p>
                </div>
              ) : null}

              {/* Channels Status Grid */}
              <div className="grid gap-3 sm:grid-cols-3">
                {testResult.channels.map((ch) => (
                  <div
                    key={ch.channel}
                    className="flex flex-col justify-between rounded-xl border border-white/[0.08] bg-white/[0.025] p-3.5"
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="font-semibold text-sm text-foreground uppercase tracking-wide">
                        {ch.channel === 'line'
                          ? 'LINE OA'
                          : ch.channel === 'discord'
                          ? 'Discord'
                          : ch.channel === 'linejs_test'
                          ? 'LINEJS'
                          : ch.channel}
                      </span>
                      {ch.ok ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success font-medium">
                          <CheckCircle2 className="h-4 w-4" /> สำเร็จ
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-danger font-medium">
                          <XCircle className="h-4 w-4" /> ล้มเหลว
                        </span>
                      )}
                    </div>
                    {ch.error ? (
                      <p className="text-xs text-danger/80 break-words mt-1">{ch.error}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">พร้อมใช้งาน</p>
                    )}
                  </div>
                ))}
              </div>

              <details className="text-xs text-muted-foreground pt-1 group">
                <summary className="cursor-pointer hover:text-foreground inline-flex items-center gap-1">
                  <Code2 className="h-3.5 w-3.5" />
                  <span>ดูข้อมูลเชิงลึก (Raw JSON)</span>
                </summary>
                <pre className="mt-2 max-h-52 overflow-auto rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[0.7rem] text-muted-foreground">
                  {JSON.stringify(testResult, null, 2)}
                </pre>
              </details>
            </CardContent>
          </Card>
        ) : null}

        {/* Configuration Info */}
        <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
          <div className="mb-2 flex items-center gap-2">
            <Bell className="h-4 w-4 text-info" />
            <span className="section-title">การตั้งค่าการแจ้งเตือน</span>
          </div>
          <p className="text-sm text-muted-foreground">
            การแจ้งเตือนจะถูกส่งผ่าน LINE OA, LINEJS test และ/หรือ Discord Webhook ตามการตั้งค่าใน Settings
          </p>
        </div>
      </ContentSection>
    </PageShell>
  )
}
