import { Outlet, createRootRoute, Navigate, useRouterState } from '@tanstack/react-router'
import { useAuth } from '../hooks/useAuth'
import { AppLayout } from '../components/layout/AppLayout'
import { Toaster } from 'sonner'

export const rootRoute = createRootRoute({
  component: RootComponent,
})

export const Route = rootRoute

function RootComponent() {
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const shouldCheckAuth = currentPath !== '/login'
  const { isAuthenticated, isLoading, user, logout } = useAuth({ enabled: shouldCheckAuth })

  // Show loading state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center gradient-bg">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">กำลังโหลด...</p>
        </div>
      </div>
    )
  }

  // Redirect to login if not authenticated (except for login page)
  if (!isAuthenticated && currentPath !== '/login') {
    return <Navigate to="/login" />
  }

  // Redirect to home if already authenticated and on login page
  if (isAuthenticated && currentPath === '/login') {
    return <Navigate to="/" />
  }

  if (isAuthenticated && user?.role !== 'admin' && ['/users', '/settings', '/audit'].includes(currentPath)) {
    return <Navigate to="/" />
  }

  // Login page without layout
  if (currentPath === '/login') {
    return (
      <>
        <Outlet />
        <Toaster position="bottom-right" />
      </>
    )
  }

  // Protected pages with layout
  return (
    <AppLayout user={user} onLogout={logout}>
      <Outlet />
    </AppLayout>
  )
}
