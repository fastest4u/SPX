# SPX Bidding Poller Changelog

## 2026-05-11
### Added & Improved
- **LINEJS Integration**:
  - เปลี่ยนจากการส่ง LINE API ธรรมดามาใช้ `linejs` library เต็มรูปแบบ ทำให้สามารถส่งข้อความแบบบัญชีจริงได้
  - นำระบบสแกน **QR Code Login** มาไว้ที่หน้าเว็บ (Dashboard Settings) พร้อมระบบ polling ตรวจสอบสถานะการล็อกอินแบบเรียลไทม์
  - เพิ่มระบบจัดการ **Target MID** ผ่านหน้า UI โดยดึงรายชื่อกลุ่ม (`C...`) อัตโนมัติจากเซสชัน LINE ของบอท ผู้ใช้สามารถคลิกเลือกกลุ่มปลายทางได้โดยไม่ต้องแก้โค้ดหรือรันสคริปต์แยก
  - ระบบบันทึกเซสชัน LINE ลง `data/linejs-storage.json` ถาวร ทำให้เมื่อเซิร์ฟเวอร์รีสตาร์ท บอทจะเชื่อมต่อใหม่ได้อัตโนมัติ ไม่ต้องสแกน QR ใหม่ทุกครั้ง

- **Poller Control (Play/Pause)**:
  - เพิ่มปุ่มสลับสถานะ (Live/Paused) ในหน้า Dashboard บริเวณมุมซ้ายบน
  - กด Pause เพื่อหยุดการส่ง Request ขอข้อมูลชั่วคราว และกด Resume เพื่อให้ระบบทำงานต่อทันที
  - ปรับระบบ `Poller` tick flow ให้เช็คค่า `pollerControl.isPaused` ถ้าระบบหยุดจะข้ามการดึง API โดยไม่ต้องปิด backend
  - บันทึกสถานะ `isPaused` ลงใน `MetricsSnapshot` พร้อมสร้าง API ใหม่: `POST /api/system/pause` และ `POST /api/system/resume`

### Documentation Updated
- `docs/notification-system.md`: เพิ่มเอกสารอธิบายการตั้งค่า LINEJS, Storage และการกำหนดเป้าหมาย (Target)
- `docs/runtime-flow.md`: เพิ่มขั้นตอนการเช็คสถานะ Play/Pause ก่อนเริ่มวงจร tick แต่ละรอบ
