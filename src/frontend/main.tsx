import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { Toaster } from 'sonner'
import { AuthError } from './lib/api'
import './index.css'

// Import the generated route tree
import { routeTree } from './routeTree.gen'

// Create a new router instance
const router = createRouter({ routeTree })

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      refetchOnWindowFocus: true,
      // Never retry auth errors (401) — they should redirect to login
      retry: (failureCount, error) => {
        if (error instanceof AuthError) return false
        return failureCount < 3
      },
    },
  },
})

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster 
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'oklch(0.08 0.02 260)',
            border: '1px solid oklch(0.2 0.02 260)',
            color: 'oklch(0.9 0.02 260)',
          },
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>
)
