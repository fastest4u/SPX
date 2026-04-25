---
tags:
  - obsidian
  - spx
  - moc
---

# SPX MOC

จุดเริ่มต้นสำหรับอ่านเอกสารระบบ SPX Bidding Poller แบบเป็นลำดับ

## อ่านตามลำดับนี้
1. [[architecture]]
2. [[runtime-flow]]
3. [[env-reference]]
4. [[deployment]]
5. [[production-cautions]]
6. [[obsidian-system]]
7. [[cheatsheet]]

## Quick summary
- ระบบหลักเป็น polling worker
- dashboard เป็น optional feature
- ข้อมูลสำคัญถูกเก็บใน MySQL
- notification ใช้ rules file เป็นหลัก
- notification ส่ง Discord/LINE จริงเมื่อมี target
- มี Docker, smoke test, health checks, readiness checks, และ RBAC สำหรับ deployment

## Notes
- เอกสารนี้เน้นให้เข้าใจระบบเร็ว
- ถ้าจะลงมือแก้ code ให้ดูไฟล์ใน `src/` คู่กับเอกสารนี้
