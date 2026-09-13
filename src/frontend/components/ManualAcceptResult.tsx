import type { AcceptAllBookingResponse } from '../types'

export interface ManualAcceptOutcome {
  bookingId: number
  teamId: number
  teamName: string
  data?: AcceptAllBookingResponse
  failed?: boolean
}

export function ManualAcceptResult({ result }: { result: ManualAcceptOutcome }) {
  const ids = result.data?.verificationStatus === 'verified_success'
    ? [...new Set(result.data.requestIds?.filter((id) => Number.isInteger(id) && id > 0) ?? [])]
    : []
  const confirmed = ids.length > 0 && result.data?.verifiedAcceptedCount === ids.length
  return (
    <div role="status" aria-label="ผลการส่งคำขอรับงาน" className="mt-3 space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm">
      <p className="font-semibold">{result.failed ? 'ส่งคำขอไม่สำเร็จหรือไม่ได้รับคำตอบ — ยังไม่ทราบผลการรับงาน' : 'ส่งคำขอแล้ว'}</p>
      <p className="break-words">Booking {result.bookingId} · ทีม {result.teamName} (#{result.teamId})</p>
      {confirmed ? <>
        <p className="text-success">ยืนยันงานที่รับใหม่ {ids.length} งาน</p>
        <p className="text-muted-foreground">ยืนยันเฉพาะงานที่ตรวจพบ ยังไม่ยืนยันว่ารับครบทั้ง booking</p>
        <details><summary className="cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-ring">ดูรหัสงานที่ยืนยันแล้ว</summary><p className="max-h-32 overflow-auto break-words py-2 font-data">{ids.join(', ')}</p></details>
      </> : <p className="text-warning">ยังยืนยันงานที่รับใหม่ไม่ได้ กรุณาตรวจสอบกับผู้ให้บริการก่อนส่งซ้ำ</p>}
      {typeof result.data?.notified === 'boolean' && <p className="text-muted-foreground">{result.data.notified ? 'ส่งแจ้งเตือนแล้ว' : 'ยังไม่ได้ส่งแจ้งเตือน'}</p>}
    </div>
  )
}
