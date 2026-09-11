import type { RuleInput, RulePreviewResult } from '../types'

export const scopeLabels = { origins: 'ต้นทาง', destinations: 'ปลายทาง', vehicle_types: 'ประเภทรถ' }

export function RuleReviewSummary({
  input,
  preview,
}: {
  input: RuleInput
  preview: RulePreviewResult
}) {
  return (
    <div className="min-w-0 space-y-4 text-sm">
      <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <p className="break-words font-bold text-foreground">{input.name}</p>
        <dl className="space-y-2">
          {(['origins', 'destinations', 'vehicle_types'] as const).map((field) => (
            <div key={field} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
              <dt className="text-muted-foreground">{scopeLabels[field]}</dt>
              <dd className="break-words">
                {input[field].join(', ') || `ทุก${scopeLabels[field]} (ไม่ได้จำกัด)`}
              </dd>
            </div>
          ))}
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
            <dt className="text-muted-foreground">เป้าหมาย</dt>
            <dd>{input.need} คัน</dd>
          </div>
        </dl>
        <p className={input.accept_all ? 'font-semibold text-warning' : 'text-foreground'}>
          {input.accept_all
            ? 'รับทั้ง booking — จำนวนคันอาจเกินเป้าหมาย'
            : 'รับเฉพาะรายการที่ตรงเงื่อนไข ตามจำนวนที่ยังต้องการ'}
        </p>
        {input.accept_all && (
          <p className="text-muted-foreground">
            เมื่อ booking ตรงเงื่อนไข ระบบรับทั้ง booking รวมรายการอื่นใน booking นั้นด้วย เช่น
            เป้าหมาย 1 คัน อาจรับได้หลายคัน
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-white/10 p-3">
          <p className="text-muted-foreground">ประวัติที่ตรวจ</p>
          <p className="font-data text-xl font-bold">
            {preview.scannedCount} <span className="text-xs">รายการ</span>
          </p>
        </div>
        <div className="rounded-xl border border-white/10 p-3">
          <p className="text-muted-foreground">ตรงเงื่อนไข</p>
          <p className="font-data text-xl font-bold">
            {preview.matchedCount} <span className="text-xs">รายการ</span>
          </p>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        ผลนี้มาจากประวัติล่าสุด ไม่ใช่งานที่พร้อมรับขณะนี้ การตรวจไม่รับงานและไม่ส่งแจ้งเตือน
        จำนวนที่ตรงเงื่อนไขไม่ใช่จำนวนที่จะรับจริง และไม่ได้แสดงขนาดเต็มของแต่ละ booking
      </p>
      <div className="space-y-2">
        <p className="font-semibold">ตัวอย่างจากประวัติ</p>
        {preview.trips.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 p-4 text-muted-foreground">
            ไม่พบตัวอย่างที่ตรงเงื่อนไขในประวัติที่ตรวจ ตรวจสอบตัวกรองหรือกลับไปแก้ไขกฎได้
          </p>
        ) : (
          preview.trips.map((trip, index) => (
            <div
              key={`${trip.request_id}-${index}`}
              className="break-words rounded-xl border border-white/10 p-3"
            >
              <p>
                {trip.origin || 'ไม่ระบุต้นทาง'} → {trip.destination || 'ไม่ระบุปลายทาง'} ·{' '}
                {trip.vehicle_type || 'ไม่ระบุรถ'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Booking {trip.booking_id ?? '—'} · รายการ {trip.request_id ?? '—'}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
