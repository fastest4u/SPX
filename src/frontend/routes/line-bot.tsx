import { useState, useEffect, useCallback } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { lineBotApi } from '../lib/api'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { PageHeader } from '../components/ui/page-header'
import { toast } from 'sonner'
import { SkeletonCard } from '../components/ui/skeleton'
import { MessageCircle, QrCode, Send, CheckCircle2, XCircle, RefreshCw, Loader2 } from 'lucide-react'
import type { LineBotStatus } from '../types'

function useLineBotGroups(enabled: boolean) {
  return useQuery({
    queryKey: ['line-bot-groups'],
    queryFn: lineBotApi.getGroups,
    enabled,
    staleTime: 5 * 60 * 1000,
  })
}

export const Route = createFileRoute('/line-bot')({
  component: LineBotComponent,
})

function LineBotComponent() {
  const [targetMid, setTargetMid] = useState('')
  const [messageText, setMessageText] = useState('')

  // Fetch status
  const statusQuery = useQuery({
    queryKey: ['line-bot-status'],
    queryFn: lineBotApi.status,
    refetchInterval: 5000,
    staleTime: 5 * 1000,
  })

  const status: LineBotStatus | undefined = statusQuery.data

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
      toast.error('เกิดข้อผิดพลาด: ' + error.message)
    },
  })

  // Send mutation
  const sendMutation = useMutation({
    mutationFn: lineBotApi.send,
    onSuccess: () => {
      toast.success('ส่งข้อความสำเร็จ!')
      setMessageText('')
    },
    onError: (error) => {
      toast.error('ส่งไม่สำเร็จ: ' + error.message)
    },
  })

  const handleLogin = useCallback(() => {
    loginMutation.mutate()
  }, [loginMutation])

  const handleSend = useCallback(() => {
    if (!targetMid.trim() || !messageText.trim()) {
      toast.error('กรุณากรอก MID และข้อความ')
      return
    }
    sendMutation.mutate({ to: targetMid.trim(), text: messageText.trim() })
  }, [targetMid, messageText, sendMutation])

  const isAuthenticated = status?.authenticated === true
  const isEnabled = status?.enabled === true
  const qrUrl = status?.qrUrl || loginMutation.data?.qrUrl
  const pincode = status?.pincode || loginMutation.data?.pincode

  const groupsQuery = useLineBotGroups(isAuthenticated)

  if (statusQuery.isLoading) {
    return (
      <div className="space-y-5 sm:space-y-6">
        <Card className="glass border-white/10">
          <SkeletonCard />
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-5 page-enter sm:space-y-6">
      <PageHeader
        icon={MessageCircle}
        title="LINE Bot"
        subtitle="เชื่อมต่อ LINE ส่วนตัวเพื่อส่งข้อความ — login ครั้งเดียว ส่งได้ตลอด"
      />

      {/* Status Card */}
      <Card className="glass border-white/10">
        <CardContent className="space-y-5 p-5 sm:p-6">
          {/* Connection Status */}
          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4">
            {isAuthenticated ? (
              <CheckCircle2 className="h-5 w-5 text-success shrink-0" />
            ) : (
              <XCircle className="h-5 w-5 text-danger shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">
                {isAuthenticated ? 'เชื่อมต่อแล้ว' : isEnabled ? 'ยังไม่ได้เชื่อมต่อ' : 'ปิดใช้งาน'}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {status?.message || 'กำลังตรวจสอบ...'}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => statusQuery.refetch()}
              disabled={statusQuery.isFetching}
              className="text-muted-foreground hover:text-foreground shrink-0"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${statusQuery.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {/* Not enabled warning */}
          {!isEnabled && (
            <div className="rounded-2xl border border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] p-4 text-sm text-warning">
              <p className="font-medium">LINE Bot ยังไม่ได้เปิดใช้งาน</p>
              <p className="mt-1 text-xs text-warning/70">
                ตั้งค่า <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono">LINEJS_TEST_ENABLED=true</code> ใน Settings แล้ว restart
              </p>
            </div>
          )}

          {/* QR Login Section */}
          {isEnabled && !isAuthenticated && (
            <div className="space-y-4">
              <Button
                onClick={handleLogin}
                disabled={loginMutation.isPending}
                className="w-full bg-[#06C755] hover:bg-[#05b34c] text-foreground font-medium shadow-lg shadow-[#06C755]/20"
              >
                {loginMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <QrCode className="h-4 w-4 mr-2" />
                )}
                {loginMutation.isPending ? 'กำลังสร้าง QR Code...' : 'เริ่ม Login ด้วย QR Code'}
              </Button>

              {/* QR URL display */}
              {qrUrl && (
                <div className="rounded-2xl border border-[#06C755]/30 bg-[#06C755]/10 p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <QrCode className="h-5 w-5 text-[#06C755]" />
                    <span className="font-medium text-foreground">สแกน QR Code</span>
                  </div>

                  <div className="text-sm text-foreground space-y-2">
                    <p>1. เปิดลิงก์ด้านล่างใน browser มือถือ หรือสแกนด้วยแอป LINE</p>
                    <a
                      href={qrUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all rounded-lg bg-white/10 px-3 py-2 text-info underline underline-offset-4 hover:text-info transition-colors"
                    >
                      {qrUrl}
                    </a>
                  </div>

                  {pincode && (
                    <div className="text-sm text-foreground">
                      <p>2. กรอก PIN ในแอป LINE:</p>
                      <div className="mt-1 inline-block rounded-lg bg-white/10 px-4 py-2 font-mono text-2xl font-bold text-foreground tracking-[0.3em]">
                        {pincode}
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-[#06C755]/70">
                    หลังจากสแกนและกรอก PIN แล้ว ระบบจะเชื่อมต่ออัตโนมัติ (auto-refresh ทุก 5 วินาที)
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Authenticated — Send Message */}
          {isAuthenticated && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] p-4">
                <p className="text-sm text-success">
                  ✅ LINE Bot พร้อมใช้งาน — ส่งข้อความได้ทันที
                </p>
              </div>

              {/* Target MID */}
              <div className="space-y-1.5">
                <label htmlFor="target-mid" className="text-sm font-medium text-foreground">
                  Target MID
                </label>
                <input
                  id="target-mid"
                  type="text"
                  value={targetMid}
                  onChange={(e) => setTargetMid(e.target.value)}
                  placeholder="u1234... (user) หรือ c5678... (group)"
                  className="w-full rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#06C755]/50 focus:outline-none focus:ring-1 focus:ring-[#06C755]/30 transition-colors"
                />
                <p className="text-xs text-muted-foreground">
                  MID ของ user เริ่มด้วย <code className="text-info">u</code>, group เริ่มด้วย <code className="text-info">c</code>
                </p>
                {isAuthenticated && groupsQuery.data?.chats && groupsQuery.data.chats.length > 0 && (
                  <div className="mt-2 rounded-lg border border-white/10 bg-white/5 p-2">
                    <p className="mb-2 text-xs text-success">พบกลุ่มที่คุณเป็นสมาชิก คลิกเลือกได้เลย:</p>
                    <div className="max-h-[150px] space-y-1 overflow-y-auto pr-2">
                      {groupsQuery.data.chats.map((chat) => (
                        <button
                          key={chat.chatMid}
                          type="button"
                          onClick={() => setTargetMid(chat.chatMid)}
                          className="flex w-full items-center justify-between rounded bg-white/5 px-2 py-1.5 text-left text-xs transition-colors hover:bg-[color:var(--color-success-soft)] group"
                        >
                          <span className="mr-2 truncate text-foreground font-medium group-hover:text-success">
                            {chat.chatName || 'ไม่ทราบชื่อ'}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-slate-500 group-hover:text-success">
                            {chat.chatMid}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {isAuthenticated && groupsQuery.isLoading && (
                  <div className="mt-1 flex items-center text-xs text-slate-400">
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" /> กำลังโหลดรายชื่อกลุ่ม...
                  </div>
                )}
              </div>

              {/* Message */}
              <div className="space-y-1.5">
                <label htmlFor="message-text" className="text-sm font-medium text-foreground">
                  ข้อความ
                </label>
                <textarea
                  id="message-text"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder="พิมพ์ข้อความที่ต้องการส่ง..."
                  rows={4}
                  className="w-full rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#06C755]/50 focus:outline-none focus:ring-1 focus:ring-[#06C755]/30 transition-colors resize-none"
                />
              </div>

              {/* Send button */}
              <Button
                onClick={handleSend}
                disabled={sendMutation.isPending || !targetMid.trim() || !messageText.trim()}
                className="w-full bg-gradient-to-r from-[#06C755] to-emerald-500 text-foreground font-medium shadow-lg shadow-emerald-500/20 hover:from-[#05b34c] hover:to-emerald-400 disabled:opacity-50"
              >
                {sendMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                {sendMutation.isPending ? 'กำลังส่ง...' : 'ส่งข้อความ'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
