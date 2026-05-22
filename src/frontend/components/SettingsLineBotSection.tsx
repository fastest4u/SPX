import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { lineBotApi } from '../lib/api'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { toast } from 'sonner'
import { QrCode, CheckCircle2, XCircle, Loader2, Send } from 'lucide-react'
import type { LineBotStatus } from '../types'
import { QRCodeSVG } from 'qrcode.react'

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
  const pincode = loginMut.data?.pincode || status?.pincode
  const chats = groupsQuery.data?.chats ?? []
  const maskedPrefix = '********'
  const isMaskedValue = (value?: string) => Boolean(value?.startsWith(maskedPrefix))
  const shortTarget = (value: string) => value.slice(-8)
  const currentTargetLabel = (value: string) =>
    isMaskedValue(value) ? `ตั้งค่าไว้แล้ว (${shortTarget(value)})` : `ตั้งค่าเอง (${shortTarget(value)})`

  const routingRows = [
    { key: 'LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_SUCCESS', label: 'Auto-accept สำเร็จ', desc: 'LINEJS → LINE OA fallback', color: '#3b82f6' },
    { key: 'LINEJS_TEST_TARGET_ID_AUTO_ACCEPT_FAILURE', label: 'Auto-accept ล้มเหลว', desc: 'LINEJS → LINE OA fallback', color: '#f43f5e' },
  ] as const

  const statusIcon = isAuth
    ? <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
    : isFormOn
      ? <QrCode className="h-5 w-5 text-amber-400 shrink-0" />
      : <XCircle className="h-5 w-5 text-rose-400/50 shrink-0" />
  const statusTitle = isAuth ? '✅ เชื่อมต่อแล้ว' : isFormOn ? '⏳ พร้อม Login' : '⬛ ปิดใช้งาน'
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
      <div className="flex items-center gap-3 rounded-2xl border border-white/10 glass p-4">
        {statusIcon}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white">{statusTitle}</div>
          <div className="text-xs text-muted-foreground sm:truncate">{statusDesc}</div>
        </div>
      </div>

      {/* Profile */}
      {isAuth && profileQuery.data && (
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-300/20 bg-emerald-300/5 p-4">
          <div className="h-10 w-10 rounded-full bg-[#06C755]/20 flex items-center justify-center text-lg shrink-0">👤</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white truncate">{profileQuery.data.displayName}</div>
            <div className="text-[11px] text-slate-400 font-mono truncate">{profileQuery.data.mid}</div>
          </div>
          <Button type="button" variant="ghost" size="sm" className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 shrink-0 h-8 px-2" onClick={() => { if (window.confirm('ต้องการออกจากระบบ LINE Bot?')) logoutMut.mutate(false) }} disabled={logoutMut.isPending}>
            {logoutMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Logout'}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 border-amber-400/30 bg-amber-400/10 px-2 text-amber-200 hover:bg-amber-400/20 hover:text-amber-100" onClick={() => { if (window.confirm('Reset LINE login and clear stored auth/E2EE data?')) logoutMut.mutate(true) }} disabled={logoutMut.isPending}>
            Reset
          </Button>
        </div>
      )}

      {/* Storage info */}
      {isAuth && storageQuery.data && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(['hasE2EEKeys', 'hasAuthState'] as const).map(k => (
            <div key={k} className={`rounded-xl border p-2.5 text-center ${storageQuery.data![k] ? 'border-emerald-500/20 bg-emerald-500/[0.05]' : 'border-amber-500/20 bg-amber-500/[0.05]'}`}>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{k === 'hasE2EEKeys' ? 'E2EE Keys' : 'Auth State'}</div>
              <div className={`text-xs font-semibold mt-0.5 ${storageQuery.data![k] ? 'text-emerald-400' : 'text-amber-400'}`}>{storageQuery.data![k] ? '✅ มี' : '⚠️ ไม่มี'}</div>
            </div>
          ))}
        </div>
      )}

      {/* Enable toggle */}
      <Card className="glass border-white/10">
        <CardContent className="pt-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-white">เปิดใช้งาน LINE Bot</div>
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

      {/* Routing config */}
      <Card className="glass border-white/10">
        <CardContent className="pt-5">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">เส้นทางการส่งข้อความ</h4>
          <div className="space-y-3">
            {routingRows.map(row => {
              const currentValue = formData[row.key] || ''
              const hasCurrentOption = currentValue ? chats.some(c => c.chatMid === currentValue) : true
              return (
              <div key={row.key} className="rounded-xl border p-3" style={{ borderColor: row.color + '1a', background: row.color + '08' }}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <span className="shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded self-start" style={{ background: row.color + '33', color: row.color }}>{row.label}</span>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-white font-medium text-sm">{row.desc}</div>
                    {isAuth && chats.length > 0 ? (
                      <select
                        value={formData[row.key] || ''}
                        onChange={e => setField(row.key, e.target.value)}
                        className="mt-1.5 w-full min-h-[2.25rem] rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-primary/50 appearance-none"
                      >
                        {currentValue && !hasCurrentOption && (
                          <option value={currentValue} className="bg-slate-900">{currentTargetLabel(currentValue)}</option>
                        )}
                        <option value="" className="bg-slate-900">{formData.LINEJS_TEST_TARGET_ID || formData.LINE_USER_ID ? `ใช้ค่าเริ่มต้น (${(formData.LINEJS_TEST_TARGET_ID || formData.LINE_USER_ID).slice(-8)})` : 'เลือกกลุ่ม...'}</option>
                        {chats.map(c => <option key={c.chatMid} value={c.chatMid} className="bg-slate-900">{c.chatName || 'ไม่ทราบชื่อ'} ({c.chatMid.slice(-8)})</option>)}
                      </select>
                    ) : (
                      <Input value={formData[row.key] || ''} onChange={e => setField(row.key, e.target.value)} placeholder="Target MID (ปล่อยว่าง = ค่าเริ่มต้น)" className="mt-1.5 h-9 text-xs" />
                    )}
                  </div>
                </div>
              </div>
            )})}
          </div>
        </CardContent>
      </Card>

      {/* Target & Device settings */}
      <Card className="glass border-white/10">
        <CardContent className="pt-5">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <label htmlFor="linejs-target-mid" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Target MID</label>
                <span className="text-xs text-muted-foreground/70">ปล่อยว่างเพื่อใช้ ID เดียวกับ LINE OA</span>
              </div>
              {isAuth && chats.length > 0 ? (
                <select
                  id="linejs-target-mid"
                  value={formData.LINEJS_TEST_TARGET_ID || ''}
                  onChange={e => setField('LINEJS_TEST_TARGET_ID', e.target.value)}
                  className="w-full min-h-[2.25rem] rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-primary/50 appearance-none"
                >
                  {formData.LINEJS_TEST_TARGET_ID && !chats.some(c => c.chatMid === formData.LINEJS_TEST_TARGET_ID) && (
                    <option value={formData.LINEJS_TEST_TARGET_ID} className="bg-slate-900">{currentTargetLabel(formData.LINEJS_TEST_TARGET_ID)}</option>
                  )}
                  <option value="" className="bg-slate-900">{formData.LINE_USER_ID ? `ใช้ค่าเริ่มต้น (${formData.LINE_USER_ID.slice(-8)})` : 'เลือกกลุ่ม...'}</option>
                  {chats.map(c => <option key={c.chatMid} value={c.chatMid} className="bg-slate-900">{c.chatName || 'ไม่ทราบชื่อ'} ({c.chatMid.slice(-8)})</option>)}
                </select>
              ) : (
                <Input value={formData.LINEJS_TEST_TARGET_ID} onChange={e => setField('LINEJS_TEST_TARGET_ID', e.target.value)} placeholder={`Uxxx... หรือ Cxxx... (ค่าเริ่มต้น: ${formData.LINE_USER_ID || 'LINE_USER_ID'})`} />
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
            <Button type="button" variant="outline" className="w-full rounded-xl" onClick={onSave} disabled={isSaving}>
              {isSaving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า LINE Bot'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* QR Login */}
      {showQr && (
        <div className="space-y-4">
          {needsSave && <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-200">⚠️ กรุณา <strong>บันทึกการตั้งค่า</strong> ก่อน แล้วรอ restart</div>}
          <Button type="button" onClick={() => { if (needsSave) { toast.error('กรุณาบันทึกก่อน'); return } loginMut.mutate() }} disabled={loginMut.isPending} className="w-full bg-[#06C755] hover:bg-[#05b34c] text-white font-medium shadow-lg shadow-[#06C755]/20">
            {loginMut.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <QrCode className="h-4 w-4 mr-2" />}
            {loginMut.isPending ? 'กำลังสร้าง QR Code...' : 'Login ด้วย QR Code'}
          </Button>
          {qrUrl && (
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/5 p-5 text-center">
              <span className="font-medium text-white">สแกน QR Code เพื่อ Login</span>
              <div className="bg-white p-4 rounded-xl shadow-lg"><QRCodeSVG value={qrUrl} size={200} level="H" includeMargin /></div>
              <p className="text-xs text-slate-400 break-all">(หรือเปิดลิงก์: <a href={qrUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">{qrUrl}</a>)</p>
              {pincode && (
                <div className="text-sm text-slate-300 w-full pt-2 border-t border-white/10">
                  <p>กรอก PIN ในแอป LINE:</p>
                  <div className="mt-2 inline-block rounded-lg bg-white/10 px-5 py-3 font-mono text-3xl font-bold text-white tracking-[0.4em] shadow-inner">{pincode}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Send test message */}
      {isAuth && (
        <Card className="glass border-emerald-300/20 bg-emerald-300/5">
          <CardContent className="pt-5">
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-white">ทดสอบส่งข้อความ</h4>
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Target MID</label>
                {isAuth && chats.length > 0 ? (
                  <select
                    value={testMid}
                    onChange={e => setTestMid(e.target.value)}
                    className="w-full min-h-[2.5rem] rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary/50 appearance-none"
                  >
                    <option value="" className="bg-slate-900">เลือกกลุ่ม...</option>
                    {chats.map(c => <option key={c.chatMid} value={c.chatMid} className="bg-slate-900">{c.chatName || 'ไม่ทราบชื่อ'} ({c.chatMid.slice(-8)})</option>)}
                  </select>
                ) : (
                  <Input value={testMid} onChange={e => setTestMid(e.target.value)} placeholder="Target MID (uxxx... / cxxx...)" />
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">ข้อความ</label>
                <textarea value={testMsg} onChange={e => setTestMsg(e.target.value)} placeholder="ข้อความ..." rows={2} className="flex min-h-[5rem] w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
              </div>
              <Button type="button" onClick={() => { if (!testMid.trim() || !testMsg.trim()) { toast.error('กรุณากรอก MID และข้อความ'); return } sendMut.mutate({ to: testMid.trim(), text: testMsg.trim() }) }} disabled={sendMut.isPending || !testMid.trim() || !testMsg.trim()} className="w-full bg-[#06C755] hover:bg-[#05b34c] text-white">
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
