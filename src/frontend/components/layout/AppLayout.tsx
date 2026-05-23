import { Outlet, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import type { AuthUser } from '../../types'
import { cn } from '../../lib/utils'
import {
  LayoutDashboard, History, FileText, Users, Settings, Bell, FileBarChart,
  LogOut, ChevronLeft, ChevronRight, ChevronDown, Truck, MessageCircle,
  Search, Command, Menu, FileImage, Wifi, BellRing
} from 'lucide-react'
import { Button } from '../ui/button'
import { Avatar } from '../ui/avatar'
import { Breadcrumb } from '../Breadcrumb'
import { useState, useEffect } from 'react'
import { useNotificationCount } from '../../hooks/useNotificationCount'
import { useSseStream } from '../../hooks/useSseContext'
import { resetCoachmark } from '../ui/coachmark'

interface AppLayoutProps {
  user: AuthUser | null
  onLogout: () => Promise<void>
  children?: React.ReactNode
}

interface NavChild {
  path: string
  label: string
  icon: typeof LayoutDashboard
}

interface NavItem {
  path: string
  label: string
  icon: typeof LayoutDashboard
  shortcut?: string
  children?: NavChild[]
}

const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, shortcut: '1' },
  { path: '/history', label: 'ประวัติงาน', icon: History, shortcut: '2' },
  { path: '/notifications', label: 'แจ้งเตือน', icon: Bell, shortcut: '3' },
  { path: '/line-bot', label: 'LINE Bot', icon: MessageCircle, shortcut: '4' },
  { path: '/line-image-extractions', label: 'LINE Runsheets', icon: FileImage, shortcut: '5' },
  { path: '/reports', label: 'รายงาน', icon: FileBarChart, shortcut: '6' },
]

const adminNavItems: NavItem[] = [
  { path: '/audit', label: 'ประวัติการใช้งาน', icon: FileText, shortcut: '7' },
  { path: '/auto-accept-history', label: 'ประวัติรับงาน', icon: Truck, shortcut: '8' },
  { path: '/users', label: 'จัดการผู้ใช้', icon: Users, shortcut: '9' },
  {
    path: '/settings',
    label: 'ตั้งค่า',
    icon: Settings,
    shortcut: '0',
    children: [
      { path: '/settings/api', label: 'API & Polling', icon: Wifi },
      { path: '/settings/notifications', label: 'การแจ้งเตือน', icon: BellRing },
      { path: '/settings/line-bot', label: 'LINE Bot', icon: MessageCircle },
    ],
  },
]

const mobileTabs = [
  { path: '/', label: 'Home', icon: LayoutDashboard },
  { path: '/history', label: 'งาน', icon: History },
  { path: '/notifications', label: 'แจ้งเตือน', icon: Bell },
  { path: '/line-bot', label: 'LINE', icon: MessageCircle },
  { path: '/line-image-extractions', label: 'Runsheets', icon: FileImage },
]

const pageLabels: Record<string, string> = {
  '/': 'Dashboard',
  '/history': 'ประวัติงาน',
  '/notifications': 'แจ้งเตือน',
  '/line-bot': 'LINE Bot',
  '/line-image-extractions': 'LINE Runsheets',
  '/auto-accept-history': 'ประวัติรับงานอัตโนมัติ',
  '/audit': 'ประวัติการใช้งาน',
  '/users': 'จัดการผู้ใช้',
  '/settings': 'ตั้งค่า',
  '/settings/api': 'ตั้งค่า / API & Polling',
  '/settings/notifications': 'ตั้งค่า / การแจ้งเตือน',
  '/settings/line-bot': 'ตั้งค่า / LINE Bot',
  '/reports': 'รายงาน',
}

function flattenNav(items: NavItem[]): Array<{ path: string; label: string; icon: typeof LayoutDashboard; shortcut?: string }> {
  const flat: Array<{ path: string; label: string; icon: typeof LayoutDashboard; shortcut?: string }> = []
  for (const item of items) {
    flat.push(item)
    if (item.children) {
      for (const child of item.children) {
        flat.push({ ...child, label: `${item.label} / ${child.label}` })
      }
    }
  }
  return flat
}

export function AppLayout({ user, onLogout, children }: AppLayoutProps) {
  const navigate = useNavigate()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const notificationCount = useNotificationCount()
  const { status: sseStatus, reconnect: reconnectSse } = useSseStream()

  const isAdmin = user?.role === 'admin'
  const allItems = isAdmin
    ? flattenNav([...navItems, ...adminNavItems])
    : flattenNav(navItems)
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
        setShortcutsOpen(false)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setCollapsed(v => !v)
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
        e.preventDefault()
        setShortcutsOpen(v => !v)
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
            const hasChildren = item.children && item.children.length > 0
            const isParentActive = currentPath === item.path || currentPath.startsWith(item.path + '/')
            const isExactActive = currentPath === item.path && !hasChildren
            const expanded = hasChildren && isParentActive && !collapsed

            return (
              <div key={item.path} className="flex flex-col">
                <Link
                  to={item.path}
                  className={cn(
                    'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
                    isExactActive || (hasChildren && isParentActive)
                      ? 'bg-accent/10 text-accent border border-accent/20 shadow-[0_0_18px_-8px_var(--color-accent)]'
                      : 'text-muted-foreground hover:text-white hover:bg-white/[0.04] border border-transparent',
                    collapsed && 'justify-center px-2'
                  )}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" />
                  {!collapsed && (
                    <>
                      <span className="flex-1 truncate">{item.label}</span>
                      {hasChildren ? (
                        <ChevronDown
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200',
                            expanded && 'rotate-0',
                            !expanded && '-rotate-90'
                          )}
                          aria-hidden="true"
                        />
                      ) : null}
                    </>
                  )}
                </Link>

                {expanded ? (
                  <div className="mt-0.5 ml-3 flex flex-col gap-0.5 border-l border-white/[0.06] pl-2">
                    {item.children!.map((child) => {
                      const ChildIcon = child.icon
                      const isChildActive = currentPath === child.path || currentPath.startsWith(child.path + '/')
                      return (
                        <Link
                          key={child.path}
                          to={child.path}
                          className={cn(
                            'group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                            isChildActive
                              ? 'bg-accent/[0.08] text-accent'
                              : 'text-muted-foreground hover:bg-white/[0.04] hover:text-white'
                          )}
                        >
                          <ChildIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                          <span className="truncate">{child.label}</span>
                        </Link>
                      )
                    })}
                  </div>
                ) : null}
              </div>
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
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-foreground text-xs font-black shadow-lg shadow-primary/20">
              SPX
            </span>
            {(!collapsed || mobileOpen) && (
              <span className="text-foreground text-sm tracking-tight">Control Center</span>
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
                <p className="text-sm font-medium text-foreground truncate">{user?.username}</p>
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

          {/* SSE indicator */}
          <button
            type="button"
            onClick={reconnectSse}
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[0.65rem] font-semibold text-muted-foreground hover:text-foreground hover:border-white/[0.15]"
            title={sseStatus === 'connected' ? 'Real-time stream เชื่อมต่อแล้ว' : sseStatus === 'connecting' ? 'กำลังเชื่อมต่อ' : 'ขาดการเชื่อมต่อ — คลิกเพื่อ reconnect'}
            aria-label={`Stream status: ${sseStatus}. Click to reconnect.`}
          >
            <span className={cn('sse-dot', sseStatus)} aria-hidden="true" />
            <span className="hidden md:inline">
              {sseStatus === 'connected' ? 'Live' : sseStatus === 'connecting' ? '…' : 'Offline'}
            </span>
          </button>

          {/* Notifications button */}
          <Link
            to="/notifications"
            className="relative text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-xl hover:bg-white/[0.05]"
            aria-label={`การแจ้งเตือน${notificationCount > 0 ? ` (${notificationCount})` : ''}`}
          >
            <Bell className="h-4.5 w-4.5" />
            {notificationCount > 0 ? (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[0.55rem] font-bold text-[color:var(--color-danger-foreground)]">
                {notificationCount}
              </span>
            ) : null}
          </Link>

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
                <div className="absolute right-0 top-full mt-2 w-56 z-50 rounded-2xl border border-white/[0.08] bg-popover p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                  <div className="px-3 py-2.5 border-b border-white/[0.06]">
                    <p className="text-sm font-medium text-foreground truncate">{user?.username}</p>
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
                      className="w-full flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-danger hover:text-danger hover:bg-[color:var(--color-danger-soft)] transition-colors"
                    >
                      <LogOut className="h-4 w-4" />
                      ออกจากระบบ
                    </button>
                  </div>
                  <div className="border-t border-white/[0.06] px-3 py-2 space-y-1">
                    <button
                      type="button"
                      onClick={() => {
                        setUserMenuOpen(false)
                        setShortcutsOpen(true)
                      }}
                      className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-[0.65rem] text-muted-foreground/70 hover:text-foreground"
                    >
                      <span>คีย์ลัดทั้งหมด</span>
                      <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-white/10 bg-white/[0.04] px-1 text-[0.6rem]">?</kbd>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUserMenuOpen(false)
                        resetCoachmark()
                        // Trigger Coachmark by navigating to "/" (root re-evaluates dismissed flag).
                        window.location.reload()
                      }}
                      className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-[0.65rem] text-muted-foreground/70 hover:text-foreground"
                    >
                      <span>ดูคำแนะนำการใช้งานอีกครั้ง</span>
                    </button>
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
              <div className="rounded-2xl border border-white/[0.08] bg-popover shadow-2xl overflow-hidden">
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
                          setSearchOpen(false)
                          void navigate({ to: match.path })
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
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto px-4 py-5 lg:px-8 lg:py-6 focus:outline-none pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-6"
        >
          {children || <Outlet />}
        </main>

        {/* Keyboard shortcuts overlay */}
        {shortcutsOpen ? (
          <>
            <div
              className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
              onClick={() => setShortcutsOpen(false)}
            />
            <div className="fixed inset-x-4 top-[15%] z-50 mx-auto max-w-md animate-in fade-in zoom-in-95 duration-200">
              <div className="rounded-2xl border border-white/[0.08] bg-popover p-5 shadow-2xl">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="section-title">คีย์ลัด</h2>
                  <button
                    type="button"
                    onClick={() => setShortcutsOpen(false)}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-white/[0.05]"
                    aria-label="ปิด"
                  >
                    Esc
                  </button>
                </div>
                <ul className="space-y-2 text-sm">
                  {[
                    { keys: ['⌘', 'K'], label: 'เปิด quick search' },
                    { keys: ['⌘', 'B'], label: 'ย่อ/ขยาย sidebar' },
                    { keys: ['?'], label: 'แสดง/ซ่อนคีย์ลัดนี้' },
                    { keys: ['Esc'], label: 'ปิด overlay ที่เปิดอยู่' },
                  ].map((row) => (
                    <li key={row.label} className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="flex items-center gap-1">
                        {row.keys.map((k) => (
                          <kbd
                            key={k}
                            className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] px-1.5 text-[0.7rem] font-semibold text-foreground"
                          >
                            {k}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        ) : null}

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
