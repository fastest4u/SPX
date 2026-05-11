import { Outlet, Link, useRouterState } from '@tanstack/react-router'
import type { AuthUser } from '../../types'
import { cn } from '../../lib/utils'
import {
  LayoutDashboard, History, FileText, Users, Settings, Bell, FileBarChart,
  LogOut, ChevronLeft, ChevronRight, Truck, MessageCircle,
  Search, Command, Menu
} from 'lucide-react'
import { Button } from '../ui/button'
import { Avatar } from '../ui/avatar'
import { Breadcrumb } from '../Breadcrumb'
import { useState, useCallback, useEffect } from 'react'

interface AppLayoutProps {
  user: AuthUser | null
  onLogout: () => Promise<void>
  children?: React.ReactNode
}

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, shortcut: '1' },
  { path: '/history', label: 'ประวัติงาน', icon: History, shortcut: '2' },
  { path: '/notifications', label: 'แจ้งเตือน', icon: Bell, shortcut: '3' },
  { path: '/line-bot', label: 'LINE Bot', icon: MessageCircle, shortcut: '4' },
  { path: '/reports', label: 'รายงาน', icon: FileBarChart, shortcut: '5' },
]

const adminNavItems = [
  { path: '/audit', label: 'ประวัติการใช้งาน', icon: FileText, shortcut: '6' },
  { path: '/auto-accept-history', label: 'ประวัติรับงาน', icon: Truck, shortcut: '7' },
  { path: '/users', label: 'จัดการผู้ใช้', icon: Users, shortcut: '8' },
  { path: '/settings', label: 'ตั้งค่า', icon: Settings, shortcut: '9' },
]

const mobileTabs = [
  { path: '/', label: 'Home', icon: LayoutDashboard },
  { path: '/history', label: 'งาน', icon: History },
  { path: '/notifications', label: 'แจ้งเตือน', icon: Bell },
  { path: '/line-bot', label: 'LINE', icon: MessageCircle },
  { path: '/reports', label: 'รายงาน', icon: FileBarChart },
]

const pageLabels: Record<string, string> = {
  '/': 'Dashboard',
  '/history': 'ประวัติงาน',
  '/notifications': 'แจ้งเตือน',
  '/line-bot': 'LINE Bot',
  '/auto-accept-history': 'ประวัติรับงานอัตโนมัติ',
  '/audit': 'ประวัติการใช้งาน',
  '/users': 'จัดการผู้ใช้',
  '/settings': 'ตั้งค่า',
  '/reports': 'รายงาน',
}

export function AppLayout({ user, onLogout, children }: AppLayoutProps) {
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [notificationCount] = useState(0)

  const isAdmin = user?.role === 'admin'
  const allItems = isAdmin ? [...navItems, ...adminNavItems] : navItems
  const pageLabel = pageLabels[currentPath] || currentPath

  const handleLogout = async () => {
    await onLogout()
  }

  useEffect(() => {
    setMobileOpen(false)
  }, [currentPath])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') {
        setSearchOpen(false)
        setUserMenuOpen(false)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setCollapsed(v => !v)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const sidebarContent = (
    <div className="flex flex-col gap-0.5 px-2">
      {navItems.map((item) => {
        const Icon = item.icon
        const isActive = currentPath === item.path
        return (
          <Link
            key={item.path}
            to={item.path}
            className={cn(
              'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
              isActive
                ? 'bg-primary/10 text-primary border border-primary/20 sidebar-active-glow'
                : 'text-muted-foreground hover:text-white hover:bg-white/[0.04] border border-transparent',
              collapsed && 'justify-center px-2'
            )}
            title={collapsed ? item.label : undefined}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" />
            {!collapsed && (
              <>
                <span className="flex-1 truncate">{item.label}</span>
                <kbd className="hidden group-hover:inline-flex h-4.5 px-1.5 rounded text-[0.6rem] font-medium text-muted-foreground/50 bg-white/[0.04] border border-white/[0.06] leading-none items-center">
                  {item.shortcut}
                </kbd>
              </>
            )}
            {isActive && (
              <span className="absolute right-1 top-1/2 -translate-y-1/2 w-1 h-5 rounded-full bg-primary hidden group-hover:hidden" />
            )}
          </Link>
        )
      })}

      {isAdmin && (
        <>
          <div className="my-2 mx-2 border-t border-white/[0.06]" />
          {!collapsed && (
            <span className="px-3 pb-1 text-[0.6rem] font-bold uppercase tracking-[0.18em] text-muted-foreground/50">
              Administration
            </span>
          )}
          {adminNavItems.map((item) => {
            const Icon = item.icon
            const isActive = currentPath === item.path
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
                  isActive
                    ? 'bg-accent/10 text-accent border border-accent/20 shadow-[0_0_18px_-8px_var(--color-accent)]'
                    : 'text-muted-foreground hover:text-white hover:bg-white/[0.04] border border-transparent',
                  collapsed && 'justify-center px-2'
                )}
                title={collapsed ? item.label : undefined}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                {!collapsed && (
                  <span className="flex-1 truncate">{item.label}</span>
                )}
              </Link>
            )
          })}
        </>
      )}
    </div>
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

      {/* Sidebar — desktop */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-white/[0.06] bg-sidebar transition-all duration-300 ease-in-out lg:relative',
          mobileOpen ? 'w-64 translate-x-0' : collapsed ? 'w-[68px]' : 'w-64',
          !mobileOpen && collapsed && 'lg:w-[68px]',
          'max-lg:-translate-x-full',
          mobileOpen && 'max-lg:translate-x-0'
        )}
      >
        {/* Logo */}
        <div className={cn(
          'flex h-16 items-center border-b border-white/[0.06] px-4',
          collapsed && !mobileOpen && 'justify-center px-2'
        )}>
          <Link to="/" className="flex items-center gap-2.5 font-bold">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 text-white text-xs font-black shadow-lg shadow-violet-500/20">
              SPX
            </span>
            {(!collapsed || mobileOpen) && (
              <span className="text-white text-sm tracking-tight">Control Center</span>
            )}
          </Link>
        </div>

        {/* Nav items */}
        <div className="flex-1 overflow-y-auto py-4 scrollbar-thin">
          {sidebarContent}
        </div>

        {/* User section */}
        <div className={cn(
          'border-t border-white/[0.06] p-3',
          collapsed && !mobileOpen && 'flex flex-col items-center'
        )}>
          <div className={cn(
            'flex items-center gap-3',
            collapsed && !mobileOpen && 'flex-col gap-2'
          )}>
            <Avatar name={user?.username} size="sm" />
            {(!collapsed || mobileOpen) && (
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{user?.username}</p>
                <div className="flex items-center gap-1.5">
                  <span className={cn(
                    'inline-block w-1.5 h-1.5 rounded-full',
                    isAdmin ? 'bg-accent' : 'bg-primary'
                  )} />
                  <p className="text-[0.65rem] text-muted-foreground capitalize">{user?.role}</p>
                </div>
              </div>
            )}
            {(!collapsed || mobileOpen) && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleLogout}
                className="text-muted-foreground hover:text-white hover:bg-white/10 shrink-0 h-8 w-8"
                title="Logout"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.06] glass px-3 lg:px-5">
          {/* Mobile menu button */}
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden text-muted-foreground hover:text-white h-8 w-8"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-4.5 w-4.5" />
          </Button>

          {/* Desktop collapse button */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden lg:flex text-muted-foreground hover:text-white h-8 w-8"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>

          {/* Breadcrumbs */}
          <Breadcrumb items={[{ label: pageLabel }]} />

          <div className="flex-1" />

          {/* Quick search trigger */}
          <button
            onClick={() => setSearchOpen(!searchOpen)}
            className="hidden sm:flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs text-muted-foreground hover:border-white/[0.15] hover:text-white transition-all"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="max-w-[160px] truncate">Quick search...</span>
            <kbd className="inline-flex items-center gap-0.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[0.6rem] text-muted-foreground/60 leading-none">
              <Command className="h-2.5 w-2.5" />K
            </kbd>
          </button>

          {/* Notifications button */}
          <button className="relative text-muted-foreground hover:text-white transition-colors p-1.5 rounded-xl hover:bg-white/[0.05]">
            <Bell className="h-4.5 w-4.5" />
            {notificationCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[0.55rem] font-bold text-white">
                {notificationCount}
              </span>
            )}
          </button>

          {/* User menu */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2 rounded-xl p-1.5 hover:bg-white/[0.05] transition-colors"
            >
              <Avatar name={user?.username} size="sm" />
            </button>

            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-2 w-56 z-50 rounded-2xl border border-white/[0.08] glass-strong p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                  <div className="px-3 py-2.5 border-b border-white/[0.06]">
                    <p className="text-sm font-medium text-white truncate">{user?.username}</p>
                    <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
                  </div>
                  <div className="py-1">
                    <Link
                      to="/settings"
                      className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted-foreground hover:text-white hover:bg-white/[0.05] transition-colors"
                      onClick={() => setUserMenuOpen(false)}
                    >
                      <Settings className="h-4 w-4" />
                      ตั้งค่า
                    </Link>
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-rose-400 hover:text-rose-300 hover:bg-rose-500/[0.08] transition-colors"
                    >
                      <LogOut className="h-4 w-4" />
                      ออกจากระบบ
                    </button>
                  </div>
                  <div className="border-t border-white/[0.06] px-3 py-2">
                    <kbd className="inline-flex items-center gap-1 text-[0.6rem] text-muted-foreground/50">
                      <Command className="h-2.5 w-2.5" />K{' '}Quick search
                    </kbd>
                  </div>
                </div>
              </>
            )}
          </div>
        </header>

        {/* Quick search modal */}
        {searchOpen && (
          <>
            <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={() => setSearchOpen(false)} />
            <div className="fixed inset-x-4 top-[20%] z-50 mx-auto max-w-lg animate-in fade-in zoom-in-95 duration-200">
              <div className="rounded-2xl border border-white/[0.08] glass-strong shadow-2xl overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <input
                    autoFocus
                    placeholder="Search pages..."
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-muted-foreground focus:outline-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setSearchOpen(false)
                      if (e.key === 'Enter') {
                        const match = allItems.find(i =>
                          i.label.toLowerCase().includes((e.target as HTMLInputElement).value.toLowerCase())
                        )
                        if (match) {
                          window.location.href = match.path
                        }
                      }
                    }}
                  />
                  <kbd className="inline-flex items-center rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[0.6rem] text-muted-foreground/60 leading-none">
                    esc
                  </kbd>
                </div>
                <div className="max-h-64 overflow-y-auto p-1.5">
                  {allItems.map(item => {
                    const Icon = item.icon
                    return (
                      <Link
                        key={item.path}
                        to={item.path}
                        onClick={() => setSearchOpen(false)}
                        className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted-foreground hover:text-white hover:bg-white/[0.05] transition-colors"
                      >
                        <Icon className="h-4 w-4 shrink-0 opacity-60" />
                        <span className="flex-1">{item.label}</span>
                        <span className="text-[0.65rem] text-muted-foreground/40">{item.path}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Page content */}
        <main className="flex-1 overflow-y-auto px-4 py-5 lg:px-8 lg:py-6">
          {children || <Outlet />}
        </main>

        {/* Mobile bottom tab bar */}
        <nav className="lg:hidden fixed inset-x-0 bottom-0 z-30 glass border-t border-white/[0.06] pb-[env(safe-area-inset-bottom)]">
          <div className="flex items-center justify-around h-14 px-1">
            {mobileTabs.map(tab => {
              const Icon = tab.icon
              const isActive = currentPath === tab.path
              return (
                <Link
                  key={tab.path}
                  to={tab.path}
                  className={cn(
                    'flex flex-col items-center justify-center gap-0.5 min-w-0 flex-1 h-full rounded-xl transition-colors',
                    isActive
                      ? 'text-primary'
                      : 'text-muted-foreground/60 hover:text-muted-foreground'
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-[0.6rem] font-medium leading-none">{tab.label}</span>
                  {isActive && (
                    <span className="absolute bottom-0.5 w-6 h-0.5 rounded-full bg-primary" />
                  )}
                </Link>
              )
            })}
          </div>
        </nav>
      </div>
    </div>
  )
}
