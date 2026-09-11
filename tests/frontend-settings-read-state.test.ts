import assert from 'node:assert/strict'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as settingsModule from '../src/frontend/lib/settings-shared.tsx'

async function main() {
  const failedClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  await assert.rejects(failedClient.fetchQuery({
    queryKey: ['settings'],
    queryFn: async () => { throw new Error('synthetic settings read failure') },
  }))
  const render = (client: QueryClient) => renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client },
      React.createElement(settingsModule.SettingsFormProvider, null,
        React.createElement('button', { type: 'button' }, 'editable-settings-sentinel'),
      ),
    ),
  )
  const failedMarkup = render(failedClient)
  assert.doesNotMatch(failedMarkup, /editable-settings-sentinel/,
    'a failed first settings read must not expose a form backed by defaults')
  assert.match(failedMarkup, /โหลดการตั้งค่าไม่สำเร็จ/)
  assert.match(failedMarkup, /ลองใหม่/)

  const pendingClient = new QueryClient()
  assert.doesNotMatch(render(pendingClient), /editable-settings-sentinel/,
    'editing must also wait while the first settings read is pending')

  const server = { values: { APP_NAME: 'Confirmed server', POLL_INTERVAL_MS: '45000' }, reloadBehavior: {} }
  const loadedClient = new QueryClient()
  loadedClient.setQueryData(['settings'], server)
  assert.match(render(loadedClient), /editable-settings-sentinel/,
    'confirmed cached server settings allow the real provider to render its children')

  const { createSettingsDraft, settingsDraftReducer } = settingsModule
  const empty = createSettingsDraft()
  assert.equal(settingsDraftReducer(empty, { type: 'change', key: 'APP_NAME', value: 'Unsafe default edit' }), empty,
    'the state layer also blocks field changes until a server baseline exists')
  let draft = settingsDraftReducer(empty, { type: 'loaded', settings: server })
  assert.equal(draft.formData.APP_NAME, 'Confirmed server')
  assert.equal(draft.formData.POLL_INTERVAL_MS, '45000')
  draft = settingsDraftReducer(draft, { type: 'change', key: 'APP_NAME', value: 'Unsaved operator edit' })
  const newerServer = { values: { APP_NAME: 'Background server', POLL_INTERVAL_MS: '90000' }, reloadBehavior: {} }
  assert.equal(settingsDraftReducer(draft, { type: 'loaded', settings: newerServer }), draft,
    'a successful background read must not erase dirty edits or replace their baseline')

  const submitted = draft.formData
  const editedDuringSave = settingsDraftReducer(draft, { type: 'change', key: 'APP_NAME', value: 'Later edit' })
  const afterSave = settingsDraftReducer(editedDuringSave, { type: 'saved', submitted })
  assert.equal(afterSave.formData.APP_NAME, 'Later edit')
  assert.equal(afterSave.isDirty, true, 'a successful older save must not mark newer edits clean')
  assert.equal(afterSave.confirmed?.values.APP_NAME, 'Unsaved operator edit')
  const clean = settingsDraftReducer(draft, { type: 'saved', submitted })
  assert.equal(clean.isDirty, false)
  assert.equal(clean.formData.APP_NAME, 'Unsaved operator edit')

  for (const client of [failedClient, pendingClient, loadedClient]) client.clear()
  console.log('frontend-settings-read-state: confirmed initialization and dirty-edit preservation passed')
}

// The repository's standalone tsx runner uses its backend JSX defaults. Supply
// React for shared UI modules compiled with classic JSX instead of Vite's runtime.
const originalReact = Object.getOwnPropertyDescriptor(globalThis, 'React')
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  if (originalReact) Object.defineProperty(globalThis, 'React', originalReact)
  else Reflect.deleteProperty(globalThis, 'React')
})
