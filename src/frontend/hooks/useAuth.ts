import { useState, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { authApi } from '../lib/api'
import type { AuthUser } from '../types'

const AUTH_KEY = 'auth'

export function useAuth() {
  const queryClient = useQueryClient()
  const [isInitialized, setIsInitialized] = useState(false)

  const { data: authData, isLoading: isChecking } = useQuery({
    queryKey: [AUTH_KEY],
    queryFn: authApi.me,
    retry: false,
    refetchOnWindowFocus: false,
    enabled: isInitialized,
  })

  useEffect(() => {
    setIsInitialized(true)
  }, [])

  const user: AuthUser | null = authData?.ok ? (authData.user ?? null) : null
  const isAuthenticated = !!user
  const isLoading = isChecking || !isInitialized

  const loginMutation = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      authApi.login(username, password),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [AUTH_KEY] })
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
  
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      window.location.href = redirectTo
    }
  }, [isAuthenticated, isLoading, redirectTo])

  return { isAuthenticated, isLoading }
}
