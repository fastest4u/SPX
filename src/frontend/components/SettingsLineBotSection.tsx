import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { lineBotApi } from '../lib/api'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { toast } from 'sonner'
import { AlertTriangle, QrCode, CheckCircle2, XCircle, Loader2, Send, UserRound } from 'lucide-react'
import type { LineBotStatus } from '../types'
import { QRCodeSVG } from 'qrcode.react'
import { safeBrowserUrl } from '../lib/utils'

interface Props {
  formData: Record<string, string>
  setField: (key: string, value: string) => void
  onSave: () => void
  isSaving: boolean
}

export function SettingsLineBotSection({ formData, setField, onSave, isSaving }: Props) {
  const [testMid, setTestMid] = useState('')
  const [testMsg, setTestMsg] = useState('')
  const qc = useQueryClient()

  const statusQuery = useQuery({
    queryKey: ['line-bot-status'],
    queryFn: lineBotApi.status,
    refetchInterval: (query) => {
      const d = query.state.data as LineBotStatus | undefined
      return d?.enabled && !d.authenticated ? 3000 : 15000
    },
  })

  const status = statusQuery.data
  const isAuth = status?.authenticated === true
  const isServerOn = status?.enabled === true
  const isFormOn = formData.LINEJS_TEST_ENABLED === 'true'
  const showQr = (isServerOn || isFormOn) && !isAuth
  const needsSave = isFormOn && !isServerOn

  const groupsQuery = useQuery({ queryKey: ['line-bot-groups'], queryFn: lineBotApi.getGroups, enabled: isAuth })
  const profileQuery = useQuery({ queryKey: ['line-bot-profile'], queryFn: lineBotApi.getProfile, enabled: isAuth, staleTime: 300000 })
  const storageQuery = useQuery({ queryKey: ['line-bot-storage'], queryFn: lineBotApi.getStorage, enabled: isAuth, refetchInterval: 10000 })

  const loginMut = useMutation({
    mutationFn: lineBotApi.login,
    onSuccess: (data) => { statusQuery.refetch(); toast[data.authenticated ? 'success' : 'info'](data.authenticated ? 'LINE Bot เชื่อมต่อสำเร็จ!' : 'สแกน QR Code ด้านล่างด้วยแอป LINE') },
    onError: (e) => toast.error('Login error: ' + e.message),
  })

  const sendMut = useMutation({
    mutationFn: lineBotApi.send,
    onSuccess: () => { toast.success('ส่งข้อความสำเร็จ!'); setTestMsg('') },
    onError: (e) => toast.error('ส่งไม่สำเร็จ: ' + e.message),
  })

  const logoutMut = useMutation({
    mutationFn: (clear: boolean) => lineBotApi.logout(clear),
    onSuccess: () => { toast.success('ออกจากระบบ LINE Bot แล้ว'); ['line-bot-status','line-bot-profile','line-bot-groups','line-bot-storage'].forEach(k => qc.invalidateQueries({ queryKey: [k] })) },
    onError: (e) => toast.error('Logout ไม่สำเร็จ: ' + e.message),
  })

  const qrUrl = loginMut.data?.qrUrl || status?.qrUrl
  const safeQrUrl = safeBrowserUrl(qrUrl, {
    allowedProtocols: ['http:', 'https:', 'line:'],
  })
  const pincode = loginMut.data?.pincode || status?.pincode
  const chats = groupsQuery.data?.chats ?? []
  const maskedPrefix = '********'
  const isMaskedValue = (value?: string) => Boolean(value?.startsWith(maskedPrefix))
  const shortTarget = (value: string) => value.slice(-8)
  const currentTargetLabel = (value: string) =>
    isMaskedValue(value) ? `ตั้งค่าไว้แล้ว (${shortTarget(value)})` : `ตั้งค่าเอง (${shortTarget(value)})`

  const statusIcon = isAuth
    ? <CheckCircle2 className="h-5 w-5 text-success shrink-0" />
    : isFormOn
      ? <QrCode className="h-5 w-5 text-warning shrink-0" />
      : <XCircle className="h-5 w-5 text-danger/50 shrink-0" />
  const statusTitle = isAuth ? 'เชื่อมต่อแล้ว' : isFormOn ? 'พร้อม Login' : 'ปิดใช้งาน'
  const statusDesc = isAuth ? status?.message : needsSave ? 'กดบันทึกก่อน แล้วจึง Login QR' : status?.message || 'กำลังตรวจสอบ...'

  const toggleClass = `relative w-12 h-7 rounded-full cursor-pointer transition-all border border-white/10 p-0 shrink-0 ${
    formData.LINEJS_TEST_ENABLED === 'true'
      ? 'bg-[#06C755] shadow-[0_0_18px_rgba(6,199,85,0.34)]'
      : 'bg-[#3a3a3c]'
  }`

  const toggleDotClass = `absolute top-[3px] left-[3px] w-5 h-5 rounded-full bg-white shadow transition-transform duration-300 ease-out ${
    formData.LINEJS_TEST_ENABLED === 'true' ? 'translate-x-5' : ''
  }`

  return (
    <div className="space-y-5">

      {/* Status indicator */}
      <div className="flex items-center gap-3 rounded-[8px] border border-white/10 bg-card/80 p-4">
        {statusIcon}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">{statusTitle}</div>
          <div className="text-xs text-muted-foreground sm:truncate">{statusDesc}</div>
        </div>
      </div>

      {/* Profile */}
      {isAuth && profileQuery.data && (
        <div className="flex flex-col gap-3 rounded-[8px] border border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] p-4 sm:flex-row sm:items-center">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-[#06C755]/20 text-[#06C755]">
            <UserRound className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate">{profileQuery.data.displayName}</div>
            <div className="text-[11px] text-slate-400 font-mono truncate">{profileQuery.data.mid}</div>
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 rounded-[8px] px-2 text-danger hover:text-danger hover:bg-[color:var(--color-danger-soft)]" onClick={() => { if (window.confirm('ต้องการออกจากระบบ LINE Bot?')) logoutMut.mutate(false) }} disabled={logoutMut.isPending}>
            {logoutMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Logout'}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 rounded-[8px] border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] px-2 text-warning hover:bg-[color:var(--color-warning-soft)] hover:text-warning" onClick={() => { if (window.confirm('Reset LINE login and clear stored auth/E2EE data?')) logoutMut.mutate(true) }} disabled={logoutMut.isPending}>
            Reset
          </Button>
        </div>
      )}

      {/* Storage info */}
      {isAuth && storageQuery.data && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(['hasE2EEKeys', 'hasAuthState'] as const).map(k => (
            <div key={k} className={`rounded-[8px] border p-2.5 text-center ${storageQuery.data![k] ? 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)]' : 'border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)]'}`}>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{k === 'hasE2EEKeys' ? 'E2EE Keys' : 'Auth State'}</div>
              <div className={`text-xs font-semibold mt-0.5 ${storageQuery.data![k] ? 'text-success' : 'text-warning'}`}>{storageQuery.data![k] ? 'มี' : 'ไม่มี'}</div>
            </div>
          ))}
        </div>
      )}

      {/* Enable toggle */}
      <Card className="rounded-[8px] border-white/10 bg-card/80 shadow-none">
        <CardContent className="pt-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">เปิดใช้งาน LINE Bot</div>
              <div className="text-xs text-muted-foreground">login QR ครั้งเดียว ส่งข้อความได้ตลอด</div>
            </div>
            <button
              type="button"
              className={toggleClass}
              aria-label="เปิดหรือปิด LINE Bot"
              aria-pressed={isFormOn}
              onClick={() => setField('LINEJS_TEST_ENABLED', formData.LINEJS_TEST_ENABLED === 'true' ? 'false' : 'true')}
            >
              <span className={toggleDotClass} />
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Target & Device settings */}
      <Card className="rounded-[8px] border-white/10 bg-card/80 shadow-none">
        <CardContent className="pt-5">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <label htmlFor="linejs-target-mid" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Target MID</label>
                <span className="text-xs text-muted-foreground/70">ใช้สำหรับทดสอบ LINEJS กลาง</span>
              </div>
              {isAuth && chats.length > 0 ? (
                <select
                  id="linejs-target-mid"
                  value={formData.LINEJS_TEST_TARGET_ID || ''}
                  onChange={e => setField('LINEJS_TEST_TARGET_ID', e.target.value)}
                  className="w-full min-h-[2.25rem] rounded-[8px] border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 appearance-none"
                >
                  {formData.LINEJS_TEST_TARGET_ID && !chats.some(c => c.chatMid === formData.LINEJS_TEST_TARGET_ID) && (
                    <option value={formData.LINEJS_TEST_TARGET_ID} className="bg-popover">{currentTargetLabel(formData.LINEJS_TEST_TARGET_ID)}</option>
                  )}
                  <option value="" className="bg-popover">เลือกกลุ่ม...</option>
                  {chats.map(c => <option key={c.chatMid} value={c.chatMid} className="bg-popover">{c.chatName || 'ไม่ทราบชื่อ'} ({c.chatMid.slice(-8)})</option>)}
                </select>
              ) : (
                <Input value={formData.LINEJS_TEST_TARGET_ID} onChange={e => setField('LINEJS_TEST_TARGET_ID', e.target.value)} placeholder="Uxxx... หรือ Cxxx..." />
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="linejs-device" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Device Type</label>
                <Input id="linejs-device" value={formData.LINEJS_TEST_DEVICE} onChange={e => setField('LINEJS_TEST_DEVICE', e.target.value)} placeholder="IOSIPAD" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="linejs-storage" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Storage Path</label>
                <Input id="linejs-storage" value={formData.LINEJS_TEST_STORAGE_PATH} onChange={e => setField('LINEJS_TEST_STORAGE_PATH', e.target.value)} placeholder="data/linejs-storage.json" />
              </div>
            </div>
            <Button type="button" variant="outline" className="w-full rounded-[8px]" onClick={onSave} disabled={isSaving}>
              {isSaving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า LINE Bot'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* QR Login */}
      {showQr && (
        <div className="space-y-4">
          {needsSave && (
            <div className="flex items-start gap-2 rounded-[8px] border border-[color:var(--color-warning-border)] bg-[color:var(--color-warning-soft)] p-4 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>กรุณา <strong>บันทึกการตั้งค่า</strong> ก่อน แล้วรอ restart</span>
            </div>
          )}
          <Button type="button" onClick={() => { if (needsSave) { toast.error('กรุณาบันทึกก่อน'); return } loginMut.mutate() }} disabled={loginMut.isPending} className="w-full rounded-[8px] bg-[#06C755] text-foreground shadow-lg shadow-[#06C755]/20 hover:bg-[#05b34c]">
            {loginMut.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <QrCode className="h-4 w-4 mr-2" />}
            {loginMut.isPending ? 'กำลังสร้าง QR Code...' : 'Login ด้วย QR Code'}
          </Button>
          {safeQrUrl && (
            <div className="flex flex-col items-center gap-4 rounded-[8px] border border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] p-5 text-center">
              <span className="font-medium text-foreground">สแกน QR Code เพื่อ Login</span>
              <div className="rounded-[8px] bg-white p-4 shadow-lg"><QRCodeSVG value={safeQrUrl} size={200} level="H" includeMargin /></div>
              <p className="text-xs text-slate-400 break-all">(หรือเปิดลิงก์: <a href={safeQrUrl} target="_blank" rel="noreferrer" className="text-info hover:underline">{safeQrUrl}</a>)</p>
              {pincode && (
                <div className="text-sm text-foreground w-full pt-2 border-t border-white/10">
                  <p>กรอก PIN ในแอป LINE:</p>
                  <div className="mt-2 inline-block rounded-[8px] bg-white/10 px-5 py-3 font-mono text-3xl font-bold text-foreground tracking-[0.4em] shadow-inner">{pincode}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Send test message */}
      {isAuth && (
        <Card className="rounded-[8px] border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] shadow-none">
          <CardContent className="pt-5">
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-foreground">ทดสอบส่งข้อความ</h4>
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Target MID</label>
                {isAuth && chats.length > 0 ? (
                  <select
                    value={testMid}
                    onChange={e => setTestMid(e.target.value)}
                    className="w-full min-h-[2.5rem] rounded-[8px] border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 appearance-none"
                  >
                    <option value="" className="bg-popover">เลือกกลุ่ม...</option>
                    {chats.map(c => <option key={c.chatMid} value={c.chatMid} className="bg-popover">{c.chatName || 'ไม่ทราบชื่อ'} ({c.chatMid.slice(-8)})</option>)}
                  </select>
                ) : (
                  <Input value={testMid} onChange={e => setTestMid(e.target.value)} placeholder="Target MID (uxxx... / cxxx...)" />
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ข้อความ</label>
                <textarea value={testMsg} onChange={e => setTestMsg(e.target.value)} placeholder="ข้อความ..." rows={2} className="flex min-h-[5rem] w-full resize-none rounded-[8px] border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
              </div>
              <Button type="button" onClick={() => { if (!testMid.trim() || !testMsg.trim()) { toast.error('กรุณากรอก MID และข้อความ'); return } sendMut.mutate({ to: testMid.trim(), text: testMsg.trim() }) }} disabled={sendMut.isPending || !testMid.trim() || !testMsg.trim()} className="w-full rounded-[8px] bg-[#06C755] text-foreground hover:bg-[#05b34c]">
                {sendMut.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                {sendMut.isPending ? 'กำลังส่ง...' : 'ส่งข้อความทดสอบ'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
