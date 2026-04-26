import { useState } from 'react'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { rootRoute } from './__root'
import { useAuth } from '../hooks/useAuth'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Activity, BellRing, Loader2, ShieldCheck } from 'lucide-react'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginComponent,
})

function LoginComponent() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { login, isLoggingIn } = useAuth({ enabled: false })

  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!username.trim() || !password.trim()) {
      setError('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน')
      return
    }

    try {
      const result = await login(username.trim(), password)
      if (result.ok) {
        void navigate({ to: '/' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ'
      // Clean up the error message if it starts with a code like "INVALID_CREDENTIALS: "
      setError(msg.includes(':') ? msg.split(':').slice(1).join(':').trim() : msg)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center gradient-bg px-3 py-8 sm:px-6 lg:px-8">
      <div className="grid w-full max-w-6xl items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        {/* Hero Section */}
        <div className="reveal-up text-center lg:text-left">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm font-semibold text-emerald-200">
            <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_14px_rgba(110,231,183,0.75)]"></span>
            Logistics command center
          </div>
          <h1 className="mx-auto max-w-2xl text-4xl font-black tracking-tight text-white sm:text-5xl lg:mx-0 lg:text-6xl">
            SPX Control Center
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-8 text-muted-foreground sm:text-lg lg:mx-0">
            จัดการ rule ค้นหางาน ติดตาม polling แบบ real-time ตรวจสอบประวัติ และควบคุมการแจ้งเตือนจากหน้าจอเดียว
          </p>
        </div>

        {/* Feature Cards */}
        <div className="grid gap-3 sm:grid-cols-3 lg:col-start-1">
          <div className="glass rounded-2xl p-4 text-left">
            <Activity className="mb-3 h-5 w-5 text-cyan-300" />
            <div className="mb-1 text-sm font-bold text-white">Live Metrics</div>
            <div className="text-xs leading-5 text-muted-foreground">สถานะระบบและ latency</div>
          </div>
          <div className="glass rounded-2xl p-4 text-left">
            <BellRing className="mb-3 h-5 w-5 text-emerald-300" />
            <div className="mb-1 text-sm font-bold text-white">Smart Alerts</div>
            <div className="text-xs leading-5 text-muted-foreground">LINE และ Discord</div>
          </div>
          <div className="glass rounded-2xl p-4 text-left">
            <ShieldCheck className="mb-3 h-5 w-5 text-violet-300" />
            <div className="mb-1 text-sm font-bold text-white">Audit Ready</div>
            <div className="text-xs leading-5 text-muted-foreground">ตรวจสอบย้อนหลังได้</div>
          </div>
        </div>

        {/* Login Form */}
        <Card className="glass border-white/10 reveal-up lg:row-span-2 lg:col-start-2">
          <CardHeader>
            <CardTitle className="text-white">เข้าสู่ระบบ</CardTitle>
            <CardDescription className="text-muted-foreground">
              ใช้บัญชีที่มีสิทธิ์เข้าถึงระบบ
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-red-200" role="alert">
                  {error}
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor="login-username" className="text-sm font-semibold text-slate-200">Username</label>
                <Input
                  id="login-username"
                  type="text"
                  placeholder="your.username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="login-password" className="text-sm font-semibold text-slate-200">Password</label>
                <Input
                  id="login-password"
                  type="password"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>

              <Button
                type="submit"
                className="w-full bg-linear-to-r from-emerald-400 to-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20 hover:from-emerald-300 hover:to-cyan-300"
                disabled={isLoggingIn}
              >
                {isLoggingIn ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    กำลังเข้าสู่ระบบ...
                  </>
                ) : (
                  'เข้าสู่ระบบ'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
