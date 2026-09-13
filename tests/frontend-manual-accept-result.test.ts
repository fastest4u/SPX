import assert from 'node:assert/strict'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ManualAcceptResult } from '../src/frontend/components/ManualAcceptResult.js'

Object.assign(globalThis, { React })
const submitted = { bookingId: 123, teamId: 2, teamName: 'ทีมทดสอบ' }
const html = (data?: Record<string, unknown>, failed = false) => renderToStaticMarkup(createElement(ManualAcceptResult, { result: { ...submitted, data: data as never, failed } }))
const unproven = html({ bookingId: 123, teamId: 2, acceptAll: true, acceptedCount: 7, requestIds: [], notified: false })
assert.match(unproven, /ส่งคำขอแล้ว/)
assert.match(unproven, /ยังยืนยันงานที่รับใหม่ไม่ได้/)
assert.doesNotMatch(unproven, /ยืนยันงานที่รับใหม่ 7/)
const partial = html({ verifiedAcceptedCount: 2, verificationStatus: 'verified_success', requestIds: [101, 102], notified: true })
assert.match(partial, /ยืนยันงานที่รับใหม่ 2 งาน/)
assert.match(partial, /เฉพาะ/)
assert.match(partial, /ส่งแจ้งเตือนแล้ว/)
const transport = html(undefined, true)
assert.match(transport, /ยังไม่ทราบผลการรับงาน/)
assert.match(transport, /ตรวจสอบ.*ก่อนส่งซ้ำ/)
assert.doesNotMatch(transport, /ผู้ให้บริการปฏิเสธ|ลองอีกครั้ง|อัตโนมัติ/)
console.log('manual acceptance panel classifies evidence and ambiguous transport safely')
