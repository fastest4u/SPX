import { Outlet, Link, useRouterState } from '@tanstack/react-router'
import type { AuthUser } from '../../types'
import { useAuth } from '../../hooks/useAuth'
import { cn } from '../../lib/utils'
import {
  LayoutDashboard,
  History,
  FileText,
  Users,
  Settings,
  Bell,
  FileBarChart,
  LogOut,
  Menu,
  X,
} from 'lucide-react'
import { Button } from '../ui/button'
import { useState } from 'react'

interface AppLayoutProps {
  user: AuthUser | null
  children?: React.ReactNode
}

const navItems = [
  { path: '/', label: 'รายการค้นหา', icon: LayoutDashboard },
  { path: '/history', label: 'ประวัติงาน', icon: History },
  { path: '/audit', label: 'ประวัติการใช้งาน', icon: FileText },
  { path: '/users', label: 'จัดการผู้ใช้', icon: Users },
  { path: '/settings', label: 'ตั้งค่า', icon: Settings },
  { path: '/notifications', label: 'แจ้งเตือน', icon: Bell },
  { path: '/reports', label: 'รายงาน', icon: FileBarChart },
]

export function AppLayout({ user, children }: AppLayoutProps) {
  const { logout } = useAuth()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const handleLogout = async () => {
    await logout()
  }

  return (
    <div className="min-h-screen gradient-bg">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-50 w-full border-b border-white/10 glass">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
          {/* Logo */}
          <div className="flex items-center gap-2 font-bold text-white">
            <span className="h-3 w-3 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500"></span>
            <span className="hidden sm:inline">SPX Control Center</span>
            <span className="sm:hidden">SPX</span>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden lg:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon
              const isActive = currentPath === item.path
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary/20 text-primary border border-primary/30'
                      : 'text-muted-foreground hover:text-white hover:bg-white/5'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              )
            })}
          </nav>

          {/* User & Mobile Menu Button */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground hidden md:inline">
              {user?.username}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              className="text-muted-foreground hover:text-white"
            >
              <LogOut className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden text-muted-foreground hover:text-white"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-t border-white/10 glass-strong">
            <nav className="flex flex-col p-4 gap-1">
              {navItems.map((item) => {
                const Icon = item.icon
                const isActive = currentPath === item.path
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setMobileMenuOpen(false)}
                    className={cn(
                      'flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-primary/20 text-primary'
                        : 'text-muted-foreground hover:text-white hover:bg-white/5'
                    )}
                  >
                    <Icon className="h-5 w-5" />
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
        {children || <Outlet />}
      </main>
    </div>
  )
}
