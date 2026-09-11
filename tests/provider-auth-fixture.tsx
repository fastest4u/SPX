import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { ProviderAuthPanel } from '../src/frontend/components/ProviderAuthPanel'
import { Button } from '../src/frontend/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../src/frontend/components/ui/dialog'
import type { ProviderAuthStatus } from '../src/frontend/types'
import '../src/frontend/index.css'

type Scenario = 'ready' | 'failure' | 'challenge' | 'rate-limit' | 'missing-account' | 'connecting' | 'connecting-stuck'

let scenario: Scenario = 'ready'
let reads = 0
let mutations = 0
let holdRead = false
let releaseRead: (() => void) | undefined
let holdMutation = false
let releaseMutation: (() => void) | undefined
let switchTeam: (() => void) | undefined
const queryClient = new QueryClient()
let status: ProviderAuthStatus = {
  teamId: 7,
  email: 'saved@example.test',
  hasPassword: true,
  status: 'connected' as const,
  lastLoginAt: null as string | null,
  expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  errorCode: null,
  retryAt: null as string | null,
}

window.fetch = async (input, init) => {
  const url = String(input)
  if (!url.includes('/provider-auth')) return new Response('{}', { status: 404 })
  const isMutation = init?.method === 'PUT' || url.endsWith('/reconnect')
  if (isMutation) {
    mutations += 1
    if (holdMutation) {
      holdMutation = false
      await new Promise<void>((resolve) => { releaseMutation = resolve })
    }
  }
  else {
    reads += 1
    const snapshot = url.includes('/teams/8/')
      ? { ...status, teamId: 8, email: 'second-team@example.test', status: 'connected', errorCode: null, retryAt: null }
      : { ...status }
    if (holdRead) {
      holdRead = false
      await new Promise<void>((resolve) => { releaseRead = resolve })
    }
    if (scenario === 'connecting' && reads >= 3) status = { ...status, status: 'connected' }
    return Response.json({ status: 'success', data: snapshot })
  }
  if (scenario === 'failure' || scenario === 'challenge') {
    // Real handled failures persist safe state but their 400/502 body has no status/retryAt.
    status = { ...status, status: scenario === 'failure' ? 'retry_wait' : 'attention', errorCode: scenario === 'failure' ? 'provider_unavailable' : 'challenge_required', retryAt: new Date(Date.now() + 60_000).toISOString() }
    return Response.json({ status: 'error', error_code: scenario === 'failure' ? 'PROVIDER_AUTH_UNAVAILABLE' : 'PROVIDER_AUTH_FAILED', message: 'fixture only' }, { status: scenario === 'failure' ? 502 : 400 })
  }
  if (init?.method === 'PUT' && scenario === 'rate-limit') {
    return Response.json({ status: 'error', error_code: 'PROVIDER_AUTH_RATE_LIMITED', message: 'fixture only', details: { retryAfterMs: 10_000 } }, { status: 429, headers: { 'Retry-After': '10' } })
  }
  if (init?.method === 'PUT' || url.endsWith('/reconnect')) {
    const body = init?.body ? JSON.parse(String(init.body)) as { email?: string } : {}
    status = { ...status, email: body.email ?? status.email, hasPassword: true, status: 'connected', lastLoginAt: new Date().toISOString(), errorCode: null, retryAt: null }
  }
  return Response.json({ status: 'success', data: status })
}

Object.assign(window, {
  __providerFixture: {
    setScenario(next: Scenario) {
      scenario = next
      if (next === 'missing-account') {
        status = { ...status, email: '', hasPassword: false, status: 'manual', lastLoginAt: null, expiresAt: null, errorCode: null, retryAt: null }
      }
      if (next === 'ready') {
        status = { ...status, email: 'saved@example.test', hasPassword: true, status: 'connected', lastLoginAt: null, expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(), errorCode: null, retryAt: null }
      }
      if (next === 'connecting' || next === 'connecting-stuck') status = { ...status, status: 'connecting' }
      reads = 0
      mutations = 0
    },
    reset() {
      scenario = 'ready'
      status = { ...status, email: 'saved@example.test', hasPassword: true, status: 'connected', lastLoginAt: null, retryAt: null, errorCode: null }
      reads = 0
      mutations = 0
    },
    counts() { return { reads, mutations } },
    holdNextRead() { holdRead = true },
    releaseRead() { releaseRead?.(); releaseRead = undefined },
    holdNextMutation() { holdMutation = true },
    releaseMutation() { releaseMutation?.(); releaseMutation = undefined },
    switchTeam() { switchTeam?.() },
    cacheKeys() { return queryClient.getQueryCache().getAll().map((query) => query.queryKey) },
  },
})

function Fixture() {
  const [open, setOpen] = useState(true)
  const [teamId, setTeamId] = useState(7)
  switchTeam = () => setTeamId(8)
  return (
    <main className="mx-auto max-w-3xl p-6">
      <Button type="button" onClick={() => setOpen(true)}>เปิดบัญชีผู้ให้บริการ</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel="ปิดหน้าต่าง" className="max-h-[90dvh] overflow-y-auto sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>บัญชีทีมทดสอบ</DialogTitle>
            <DialogDescription>ข้อมูลจำลองสำหรับตรวจสอบหน้าจอ</DialogDescription>
          </DialogHeader>
          <ProviderAuthPanel teamId={teamId} />
        </DialogContent>
      </Dialog>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Fixture />
      <Toaster theme="dark" />
    </QueryClientProvider>
  </React.StrictMode>,
)
