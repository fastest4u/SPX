import { useQuery } from '@tanstack/react-query'
import { Eye, Loader2, Target, Truck } from 'lucide-react'
import { rulesApi } from '../lib/api'
import type { NotifyRule, RulePreviewMatch } from '../types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

interface RulePreviewDialogProps {
  rule: NotifyRule | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function formatTripLabel(trip: RulePreviewMatch) {
  const origin = trip.origin || 'ไม่ระบุต้นทาง'
  const destination = trip.destination || 'ไม่ระบุปลายทาง'
  const vehicleType = trip.vehicle_type || 'ไม่ระบุรถ'
  return `${origin} -> ${destination} · ${vehicleType}`
}

export function RulePreviewDialog({ rule, open, onOpenChange }: RulePreviewDialogProps) {
  const previewQuery = useQuery({
    queryKey: ['rule-preview', rule?.id],
    queryFn: () => {
      if (!rule) throw new Error('No rule selected')
      return rulesApi.preview(rule, { limit: 200, sampleLimit: 8 })
    },
    enabled: open && !!rule,
    staleTime: 30_000,
  })

  const preview = previewQuery.data

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-2xl border border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] p-2 text-info">
              <Eye className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>Rule dry-run preview</DialogTitle>
              <DialogDescription>
                ทดลอง match จากประวัติล่าสุด 200 รายการ โดยไม่ส่งแจ้งเตือนและไม่รับงานจริง
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {!rule ? null : previewQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            กำลังคำนวณ dry-run...
          </div>
        ) : previewQuery.isError ? (
          <div className="rounded-2xl border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-soft)] p-4 text-sm text-foreground">
            โหลด preview ไม่สำเร็จ: {previewQuery.error.message}
          </div>
        ) : preview ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-linear-to-br from-[color:var(--color-info-soft)] via-white/[0.03] to-[color:var(--color-success-soft)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Testing rule</div>
                  <div className="mt-1 text-lg font-black text-foreground">{rule.name}</div>
                </div>
                <Badge variant={preview.wouldMatch ? 'emerald' : 'amber'}>
                  {preview.wouldMatch ? 'Would trigger' : 'No trigger'}
                </Badge>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <PreviewMetric label="Matched" value={`${preview.matchedCount}`} tone="cyan" />
                <PreviewMetric label="Need" value={`${preview.need}`} tone="emerald" />
                <PreviewMetric label="Scanned" value={`${preview.scannedCount}`} tone="slate" />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                <Truck className="h-4 w-4 text-info" />
                ตัวอย่างงานที่ match
              </div>
              {preview.trips.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-5 text-sm text-muted-foreground">
                  ไม่พบงานที่ตรงกับ rule นี้ใน sample ล่าสุด
                </div>
              ) : (
                <div className="space-y-2">
                  {preview.trips.map((trip, index) => (
                    <div key={`${trip.request_id ?? index}-${index}`} className="rounded-xl border border-white/[0.07] bg-white/[0.04] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-slate-100">{formatTripLabel(trip)}</div>
                        <Badge variant="slate">#{trip.request_id ?? 'n/a'}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Booking {trip.booking_id ?? 'n/a'} · Standby {trip.standby_datetime || 'n/a'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Target className="h-3.5 w-3.5" />
            Dry-run only
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>ปิด</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PreviewMetric({ label, value, tone }: { label: string; value: string; tone: 'cyan' | 'emerald' | 'slate' }) {
  const classes = {
    cyan: 'border-[color:var(--color-info-border)] bg-[color:var(--color-info-soft)] text-info',
    emerald: 'border-[color:var(--color-success-border)] bg-[color:var(--color-success-soft)] text-success',
    slate: 'border-slate-300/20 bg-slate-300/10 text-foreground',
  }

  return (
    <div className={`rounded-xl border px-3 py-2.5 ${classes[tone]}`}>
      <div className="text-[0.6rem] font-bold uppercase tracking-[0.14em] opacity-70">{label}</div>
      <div className="font-mono text-xl font-black tracking-tight">{value}</div>
    </div>
  )
}
