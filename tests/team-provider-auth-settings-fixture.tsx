import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { Route } from '../src/frontend/routes/teams'
import '../src/frontend/index.css'

const Teams = Route.options.component as React.ComponentType
ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Teams />
    <Toaster theme="dark" />
  </QueryClientProvider>,
)
