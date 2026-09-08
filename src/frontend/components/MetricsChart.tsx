import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { MetricsHistoryRow } from '../types'

function formatHourLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}

export default function MetricsChart({ rows }: { rows: MetricsHistoryRow[] }) {
  const data = rows
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map((row) => ({
      time: formatHourLabel(row.createdAt),
      successRate: Math.round(row.successRate * 100) / 100,
      latencyAvg: Math.round(row.latencyAvg),
      latencyP95: Math.round(row.latencyP95),
    }))

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
          <defs>
            <linearGradient id="latencyAvgGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-info)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--color-info)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="latencyP95Gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis
            dataKey="time"
            tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis
            tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            unit="ms"
            width={48}
          />
          <Tooltip
            cursor={{ stroke: 'var(--ring)', strokeOpacity: 0.18 }}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              fontSize: 12,
              color: 'var(--popover-foreground)',
            }}
            labelStyle={{ color: 'var(--muted-foreground)' }}
          />
          <Area
            type="monotone"
            dataKey="latencyAvg"
            name="avg latency"
            stroke="var(--color-info)"
            strokeWidth={2}
            fill="url(#latencyAvgGradient)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="latencyP95"
            name="p95 latency"
            stroke="var(--primary)"
            strokeWidth={2}
            fill="url(#latencyP95Gradient)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
