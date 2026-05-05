import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rootRoute } from './__root'
import { autoAcceptHistoryApi } from '../lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { formatDateTime } from '../lib/utils'
import { Search, CheckCircle2, XCircle, Truck } from 'lucide-react'
import type { AutoAcceptHistoryItem } from '../types'

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auto-accept-history',
  component: AutoAcceptHistoryComponent,
})

const STATUS_OPTIONS = [
  { value: '', label: '\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14' },
  { value: 'success', label: '\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08' },
  { value: 'failed', label: '\u0E25\u0E49\u0E21\u0E40\u0E2B\u0E25\u0E27' },
]

const AAH_COLUMNS: DataTableColumn<AutoAcceptHistoryItem>[] = [
  {
    header: 'ID',
    render: (item) => <span className="text-muted-foreground">{item.id}</span>,
  },
  {
    header: 'Rule',
    render: (item) => (
      <span className="status-pill border-violet-300/20 bg-violet-300/10 text-violet-300">
        {item.ruleName}
      </span>
    ),
  },
  {
    header: '\u0E40\u0E2A\u0E49\u0E19\u0E17\u0E32\u0E07',
    render: (item) => (
      <span className="text-muted-foreground text-sm">
        {item.origin} {'\u2192'} {item.destination}
      </span>
    ),
  },
  {
    header: '\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E23\u0E16',
    render: (item) => <span className="text-muted-foreground text-sm">{item.vehicleType || '\u2014'}</span>,
  },
  {
    header: '\u0E07\u0E32\u0E19\u0E17\u0E35\u0E48\u0E23\u0E31\u0E1A',
    render: (item) => (
      <span className="text-muted-foreground">
        {item.requestIds.length} request{item.requestIds.length > 1 ? 's' : ''}
      </span>
    ),
  },
  {
    header: '\u0E2A\u0E16\u0E32\u0E19\u0E30',
    render: (item) =>
      item.status === 'success' ? (
        <span className="flex items-center gap-1 text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          {'\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08'}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-red-400" title={item.errorMessage}>
          <XCircle className="h-4 w-4" />
          {'\u0E25\u0E49\u0E21\u0E40\u0E2B\u0E25\u0E27'}
        </span>
      ),
  },
  {
    header: '\u0E40\u0E27\u0E25\u0E32',
    render: (item) => <span className="text-muted-foreground text-sm">{formatDateTime(item.createdAt)}</span>,
  },
]

function AutoAcceptHistoryComponent() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [ruleName, setRuleName] = useState('')

  const { data: items = [] } = useQuery({
    queryKey: ['autoAcceptHistory', { search, status, ruleName }],
    queryFn: () =>
      autoAcceptHistoryApi.list({
        search: search || undefined,
        status: status || undefined,
        ruleName: ruleName || undefined,
        limit: 200,
      }),
  })

  const handleReset = () => {
    setSearch('')
    setStatus('')
    setRuleName('')
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <Card className="glass border-white/10">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Truck className="h-5 w-5 text-cyan-400" />
            {'\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E01\u0E32\u0E23\u0E23\u0E31\u0E1A\u0E07\u0E32\u0E19\u0E2D\u0E31\u0E15\u0E42\u0E19\u0E21\u0E31\u0E15\u0E34'}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {'\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E01\u0E32\u0E23 auto-accept \u0E17\u0E38\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07'}
          </p>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_auto]">
              <div className="space-y-2">
                <label htmlFor="aah-search" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E04\u0E49\u0E19\u0E2B\u0E32'}</label>
                <Input
                  id="aah-search"
                  placeholder={'\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E40\u0E2A\u0E49\u0E19\u0E17\u0E32\u0E07, \u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E23\u0E16'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="aah-rule" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Rule</label>
                <Input
                  id="aah-rule"
                  placeholder={'\u0E0A\u0E37\u0E48\u0E2D Rule'}
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="aah-status" className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E2A\u0E16\u0E32\u0E19\u0E30'}</label>
                <select
                  id="aah-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} className="bg-slate-900">
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button className="w-full lg:w-auto" variant="outline" onClick={handleReset}>
                  {'\u0E25\u0E49\u0E32\u0E07'}
                </Button>
              </div>
            </div>
          </div>

          {/* Data Table */}
          <DataTable
            columns={AAH_COLUMNS}
            data={items}
            keyField={(item) => item.id}
            emptyIcon={<Search className="h-12 w-12 mx-auto mb-4 opacity-50" />}
            emptyMessage={'\u0E44\u0E21\u0E48\u0E1E\u0E1A\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E01\u0E32\u0E23\u0E23\u0E31\u0E1A\u0E07\u0E32\u0E19\u0E2D\u0E31\u0E15\u0E42\u0E19\u0E21\u0E31\u0E15\u0E34'}
            renderMobile={(item) => (
              <AutoAcceptMobileCardContent item={item} />
            )}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function AutoAcceptMobileCardContent({ item }: { item: AutoAcceptHistoryItem }) {
  const isSuccess = item.status === 'success'
  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-3">
        <span className="status-pill border-violet-300/20 bg-violet-300/10 text-violet-300">
          {item.ruleName}
        </span>
        <span className={`flex items-center gap-1 rounded-2xl px-3 py-2 text-xs font-black ${
          isSuccess ? 'bg-emerald-400/10 text-emerald-400 border border-emerald-400/20' : 'bg-red-400/10 text-red-400 border border-red-400/20'
        }`}>
          {isSuccess ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {isSuccess ? '\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08' : '\u0E25\u0E49\u0E21\u0E40\u0E2B\u0E25\u0E27'}
        </span>
      </div>
      <div className="grid gap-3 text-sm">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E40\u0E2A\u0E49\u0E19\u0E17\u0E32\u0E07'}</div>
          <div className="mt-1 font-semibold text-white">{item.origin} {'\u2192'} {item.destination}</div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E07\u0E32\u0E19\u0E17\u0E35\u0E48\u0E23\u0E31\u0E1A'}</div>
            <div className="mt-1 text-slate-200">{item.requestIds.length} requests</div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E23\u0E16'}</div>
            <div className="mt-1 text-slate-200">{item.vehicleType || '\u2014'}</div>
          </div>
        </div>
        {item.errorMessage ? (
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-red-400">Error</div>
            <div className="mt-1 break-words text-sm text-red-300">{item.errorMessage}</div>
          </div>
        ) : null}
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{'\u0E40\u0E27\u0E25\u0E32'}</div>
          <div className="mt-1 text-slate-200">{formatDateTime(item.createdAt)}</div>
        </div>
      </div>
    </>
  )
}
