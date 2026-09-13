if (process.env.RUN_E2E !== 'true') { console.log('Skipping E2E test (RUN_E2E not set to true).'); process.exit(0) }
import { runOperatorE2e } from './operator-ui-e2e.js'
const pages = [
  { path: '/', heading: 'ภาพรวมระบบ' },
  { path: '/history', heading: 'ประวัติงาน' },
  { path: '/notifications', heading: 'แจ้งเตือน' },
  { path: '/line-bot', heading: 'LINE Bot' },
  { path: '/reports', heading: 'รายงาน' },
  { path: '/auto-accept-history', heading: 'ประวัติการรับงานอัตโนมัติ' },
  { path: '/line-image-extractions', heading: 'LINE Runsheets' },
  { path: '/audit', heading: 'ประวัติการใช้งาน' },
  { path: '/teams', heading: 'จัดการทีม' },
  { path: '/users', heading: 'จัดการผู้ใช้งาน' },
  { path: '/settings', heading: 'ตั้งค่าระบบ' },
]
runOperatorE2e('admin', pages).catch((error) => { console.error(error); process.exitCode = 1 })
