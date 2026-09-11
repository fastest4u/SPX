import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DataTable } from '../src/frontend/components/DataTable.tsx'

Object.assign(globalThis, { React })

const markup = renderToStaticMarkup(
  <DataTable
    columns={[
      {
        header: 'Request ID',
        sortKey: 'request_id',
        render: (item: { id: string }) => item.id,
      },
    ]}
    data={[{ id: 'row-7' }]}
    keyField={(item) => item.id}
    bulkActions={[]}
  />,
)

assert.match(markup, /<th[^>]*aria-sort="none"[^>]*><button[^>]*type="button"/, 'sortable headers render a native keyboard-operable button inside the aria-sort column header')
assert.match(markup, /aria-label="เลือกแถว row-7"/, 'row selection names identify the row')

const sortedMarkup = renderToStaticMarkup(
  <DataTable
    columns={[
      {
        header: 'Request ID',
        sortKey: 'request_id',
        render: (item: { id: string }) => item.id,
      },
    ]}
    data={[{ id: 'row-7' }]}
    keyField={(item) => item.id}
    sorting={{
      sortKey: 'request_id',
      sortDir: 'asc',
      onSortChange: () => {},
    }}
  />,
)

assert.match(sortedMarkup, /<th[^>]*aria-sort="ascending"/, 'the active sort direction is exposed on the native column header')

console.log('frontend-data-table-accessibility: all assertions passed')
