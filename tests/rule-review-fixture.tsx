import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RuleEditorDialog } from '../src/frontend/components/RuleEditorDialog'
import type { NotifyRule } from '../src/frontend/types'
import '../src/frontend/index.css'

const params = new URLSearchParams(location.search)
const client = new QueryClient()
client.setQueryData(['auth'], { id: 3, username: 'fixture-user', role: params.get('role') ?? 'user', teamId: 7 })
const rule: NotifyRule = {
  id: 'fixture-rule', teamId: 7, name: 'Original route', origins: ['A'], destinations: ['B'],
  vehicle_types: ['4W'], need: 1, enabled: true, fulfilled: false,
  auto_accept: true, auto_accepted: false, accept_all: params.get('mode') === 'all',
}

function Fixture() {
  const [open, setOpen] = useState(false)
  return <>
    <button onClick={() => setOpen(true)}>Open editor</button>
    <RuleEditorDialog open={open} onOpenChange={setOpen} rule={rule} />
  </>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}><Fixture /></QueryClientProvider>,
)
