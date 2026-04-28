import { Outlet, Link, useRouterState } from '@tanstack/react-router'
import type { AuthUser } from '../../types'
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
  ChevronLeft,
  ChevronRight,
  Truck,
} from 'lucide-react'
import { Button } from '../ui/button'
import { useState } from 'react'

interface AppLayoutProps {
  user: AuthUser | null
  onLogout: () => Promise<void>
  children?: React.ReactNode
}

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/history', label: 'ประวัติงาน', icon: History },
  { path: '/notifications', label: 'แจ้งเตือน', icon: Bell },
  { path: '/reports', label: 'รายงาน', icon: FileBarChart },
]

const adminNavItems = [
  { path: '/audit', label: 'ประวัติการใช้งาน', icon: FileText },
  { path: '/auto-accept-history', label: 'ประวัติรับงาน', icon: Truck },
  { path: '/users', label: 'จัดการผู้ใช้', icon: Users },
  { path: '/settings', label: 'ตั้งค่า', icon: Settings },
]

export function AppLayout({ user, onLogout, children }: AppLayoutProps) {
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  const isAdmin = user?.role === 'admin'
  const allItems = isAdmin ? [...navItems, ...adminNavItems] : navItems

  const handleLogout = async () => {
    await onLogout()
  }

  const sidebarContent = (
    <nav className="flex flex-col gap-1 px-2">
      {navItems.map((item) => {
        const Icon = item.icon
        const isActive = currentPath === item.path
        return (
          <Link
            key={item.path}
            to={item.path}
            onClick={() => setMobileOpen(false)}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
              isActive
                ? 'bg-primary/10 text-primary border border-primary/20 shadow-[0_0_18px_-8px_var(--color-primary)]'
                : 'text-muted-foreground hover:text-white hover:bg-white/[0.04] border border-transparent',
              collapsed && !mobileOpen && 'justify-center px-2'
            )}
            title={collapsed && !mobileOpen ? item.label : undefined}
          >
            <Icon className="h-4.5 w-4.5 shrink-0" />
            {(!collapsed || mobileOpen) && <span>{item.label}</span>}
          </Link>
        )
      })}
      {isAdmin && (
        <div className="my-2 border-t border-sidebar-border/50" />
      )}
      {isAdmin && adminNavItems.map((item) => {
        const Icon = item.icon
        const isActive = currentPath === item.path
        return (
          <Link
            key={item.path}
            to={item.path}
            onClick={() => setMobileOpen(false)}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
              isActive
                ? 'bg-accent/10 text-accent border border-accent/20 shadow-[0_0_18px_-8px_var(--color-accent)]'
                : 'text-muted-foreground hover:text-white hover:bg-white/[0.04] border border-transparent',
              collapsed && !mobileOpen && 'justify-center px-2'
            )}
            title={collapsed && !mobileOpen ? item.label : undefined}
          >
            <Icon className="h-4.5 w-4.5 shrink-0" />
            {(!collapsed || mobileOpen) && <span>{item.label}</span>}
          </Link>
        )
      })}
    </nav>
  )

  return (
    <div className="flex h-screen overflow-hidden gradient-bg">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300 ease-in-out lg:relative',
          mobileOpen ? 'w-64 translate-x-0' : collapsed ? 'w-[68px]' : 'w-64',
          !mobileOpen && collapsed && 'lg:w-[68px]',
          'max-lg:-translate-x-full',
          mobileOpen && 'max-lg:translate-x-0'
        )}
      >
        {/* Logo */}
        <div className={cn(
          'flex h-16 items-center border-b border-sidebar-border px-4',
          collapsed && !mobileOpen && 'justify-center px-2'
        )}>
          <Link to="/" className="flex items-center gap-2.5 font-bold" onClick={() => setMobileOpen(false)}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 to-violet-500 text-white text-xs font-black">
              SPX
            </span>
            {(!collapsed || mobileOpen) && (
              <span className="text-white text-sm tracking-tight">Control Center</span>
            )}
          </Link>
        </div>

        {/* Nav items */}
        <div className="flex-1 overflow-y-auto py-4">
          <div className={cn(!collapsed || mobileOpen ? 'mb-3 px-4' : 'mb-3 px-2')}>
            {(!collapsed || mobileOpen) && (
              <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-muted-foreground mb-2 px-2">
                {isAdmin ? 'Admin' : 'Menu'}
              </p>
            )}
          </div>
          {sidebarContent}
        </div>

        {/* User + Logout */}
        <div className={cn(
          'border-t border-sidebar-border p-3',
          collapsed && !mobileOpen && 'flex flex-col items-center'
        )}>
          <div className={cn(
            'flex items-center gap-3',
            collapsed && !mobileOpen && 'flex-col gap-2'
          )}>
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400/30 to-violet-500/30 text-xs font-bold text-white border border-white/10">
              {user?.username?.charAt(0)?.toUpperCase() || '?'}
            </div>
            {(!collapsed || mobileOpen) && (
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{user?.username}</p>
                <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              className={cn(
                'text-muted-foreground hover:text-white hover:bg-white/10 shrink-0',
                collapsed && !mobileOpen && 'h-7 w-7'
              )}
              title="Logout"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-white/[0.06] glass px-4 lg:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden text-muted-foreground hover:text-white"
            onClick={() => setMobileOpen(true)}
          >
            <LayoutDashboard className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden lg:flex text-muted-foreground hover:text-white"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
          <div className="flex-1" />
          {/* Active page indicator */}
          <span className="text-sm text-muted-foreground hidden sm:inline">
            {allItems.find((i) => currentPath === i.path)?.label ?? currentPath}
          </span>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
          {children || <Outlet />}
        </main>
      </div>
    </div>
  )
}
