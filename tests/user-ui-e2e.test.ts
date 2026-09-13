if (process.env.RUN_E2E !== 'true') { console.log('Skipping E2E test (RUN_E2E not set to true).'); process.exit(0) }
import { runOperatorE2e } from './operator-ui-e2e.js'
const pages = [
  { path: '/', heading: 'ภาพรวมระบบ' },
  { path: '/history', heading: 'ประวัติงาน' },
  { path: '/notifications', heading: 'แจ้งเตือน' },
  { path: '/line-bot', heading: 'LINE Bot' },
  { path: '/reports', heading: 'รายงาน' },
  { path: '/auto-accept-history', heading: 'ประวัติการรับงานอัตโนมัติ' },
]
runOperatorE2e('user', pages).catch((error) => { console.error(error); process.exitCode = 1 })
