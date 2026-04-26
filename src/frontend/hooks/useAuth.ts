import { useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { authApi } from '../lib/api'
import type { AuthUser } from '../types'

const AUTH_KEY = 'auth'

export function useAuth(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient()
  const enabled = options?.enabled ?? true

  const { data: rawUser, isLoading: isChecking } = useQuery<AuthUser>({
    queryKey: [AUTH_KEY],
    queryFn: authApi.me,
    retry: false,
    refetchOnWindowFocus: false,
    // Keep cached auth data for 2 minutes to prevent race conditions
    // between login success and query invalidation
    staleTime: 2 * 60 * 1000,
    enabled,
  })

  const user: AuthUser | null = rawUser ?? null
  const isAuthenticated = !!user
  const isLoading = enabled ? isChecking : false

  const loginMutation = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      authApi.login(username, password),
    onSuccess: () => {
      // Immediately refetch auth state to get user info
      // Use refetch instead of invalidate to avoid race conditions
      void queryClient.refetchQueries({ queryKey: [AUTH_KEY] })
    },
  })

  const logoutMutation = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => {
      queryClient.setQueryData([AUTH_KEY], null)
      queryClient.clear()
    },
  })

  const login = useCallback(async (username: string, password: string) => {
    const result = await loginMutation.mutateAsync({ username, password })
    return result
  }, [loginMutation])

  const logout = useCallback(async () => {
    await logoutMutation.mutateAsync()
  }, [logoutMutation])

  return {
    user,
    isAuthenticated,
    isLoading,
    login,
    logout,
    loginError: loginMutation.error,
    isLoggingIn: loginMutation.isPending,
    isLoggingOut: logoutMutation.isPending,
  }
}

export function useRequireAuth(redirectTo: string = '/login') {
  const { isAuthenticated, isLoading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      // Use router navigation instead of window.location.replace
      // to avoid full page reload loops
      void navigate({ to: redirectTo })
    }
  }, [isAuthenticated, isLoading, redirectTo, navigate])

  return { isAuthenticated, isLoading }
}
