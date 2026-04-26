import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { rootRoute } from './__root'
import { useAuth } from '../hooks/useAuth'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginComponent,
})

function LoginComponent() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { login, isLoggingIn } = useAuth()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!username.trim() || !password.trim()) {
      setError('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน')
      return
    }

    const result = await login(username.trim(), password)

    if (!result.ok) {
      setError(result.error?.message || 'เข้าสู่ระบบไม่สำเร็จ')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center gradient-bg px-4">
      <div className="w-full max-w-md">
        {/* Hero Section */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="h-4 w-4 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500"></span>
            <h1 className="text-2xl font-bold text-white">SPX Control Center</h1>
          </div>
          <p className="text-muted-foreground">
            เข้าสู่ระบบเพื่อจัดการการค้นหา รายงาน settings และ audit log
          </p>
        </div>

        {/* Feature Cards */}
        <div className="grid grid-cols-3 gap-3 mb-8">
          <div className="glass rounded-xl p-3 text-center">
            <div className="text-sm font-medium text-white mb-1">Theme</div>
            <div className="text-xs text-muted-foreground">Unified</div>
          </div>
          <div className="glass rounded-xl p-3 text-center">
            <div className="text-sm font-medium text-white mb-1">CSS</div>
            <div className="text-xs text-muted-foreground">Tailwind v4</div>
          </div>
          <div className="glass rounded-xl p-3 text-center">
            <div className="text-sm font-medium text-white mb-1">UI</div>
            <div className="text-xs text-muted-foreground">Shadcn</div>
          </div>
        </div>

        {/* Login Form */}
        <Card className="glass border-white/10">
          <CardHeader>
            <CardTitle className="text-white">Sign in</CardTitle>
            <CardDescription className="text-muted-foreground">
              ใช้บัญชีที่มีสิทธิ์เข้าถึงระบบ
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  {error}
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Username</label>
                <Input
                  type="text"
                  placeholder="your.username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="bg-white/5 border-white/10 text-white placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Password</label>
                <Input
                  type="password"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-white/5 border-white/10 text-white placeholder:text-muted-foreground"
                />
              </div>

              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-cyan-500 to-violet-500 hover:from-cyan-600 hover:to-violet-600"
                disabled={isLoggingIn}
              >
                {isLoggingIn ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
