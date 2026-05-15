---
name: spx-strict-pr-review
description: Strict 8-category code review with P0-P3 severity, auto-fix loop, and merge gate. Use when the user invokes `$spx-strict-pr-review`, asks for strict review, or before production-impacting merges.
---

# Strict PR Review 8 Category (SPX Edition)

กระบวนการตายตัว 7 ขั้น ห้ามข้ามลำดับ

## Non-Negotiable Rules

- ทำงานตามลำดับ Step 1 → 7 เท่านั้น
- สรุปผลภาษาไทยเสมอ
- ทุกประเด็นรีวิวต้องระบุหลักฐาน (ไฟล์/บรรทัด/ฟังก์ชัน/พฤติกรรม)
- 🚨 **CRITICAL**: **ห้ามกด Merge เด็ดขาดหากยังมี P0/P1/P2/P3 หลงเหลืออยู่**
- เมื่อพบ P0-P3 ต้อง **หยุดกระบวนการ Merge ทันที แล้วทำการแก้ไขอัตโนมัติ (Auto-Fix)** โดยไม่ต้องถาม user — ยกเว้นมี business ambiguity
- หลังแก้ไขแล้ว → commit, push, แล้ว **รีวิวรอบใหม่ทั้งหมด** จนกว่าจะเคลียร์ (สูงสุด 3 รอบ)
- ตรวจเฉพาะ code ใน diff — ห้ามยก issue ของ pre-existing code
- สำหรับ SPX: แก้ไขเฉพาะ `src/` เป็นหลัก ห้ามแก้ `dist/`, `data/`, หรือยุ่งกับ `.env`

## Step 1: ตรวจ Uncommitted Changes

1. `git status --porcelain`
2. ถ้ามี uncommitted → `git add -A && git commit -m "<conventional-commit>"`
3. ถ้าไม่มี → ตรวจ unpushed commits, ถ้าไม่มี → หยุด

## Step 2: ตรวจ Branch และ Normalize Base

1. `git branch --show-current`
2. กำหนด base (main ก่อน, ถ้าไม่มีให้เป็น master)
3. ถ้าอยู่บน base มี unpushed → แตก branch ใหม่

## Step 3: Push Branch

```bash
git push -u origin <branch-name>
```

## Step 4: สร้าง PR

- ดึง owner/repo จาก `git remote get-url origin`
- **title**: conventional commit
- **head**: branch ปัจจุบัน
- **base**: branch หลัก

## Step 5: Code Review เข้มงวด 8 หมวด

### ก่อนรีวิว (Mandatory)
1. ดึง diff และ file list
2. **อ่านไฟล์ที่เกี่ยวข้องทั้งฟังก์ชัน/class** ไม่ใช่แค่ diff

### Severity Levels

| Level | คำอธิบาย | ตัวอย่าง |
|---|---|---|
| **P0** | วิกฤต — ต้องแก้ก่อน merge | ข้อมูลลับรั่ว, แก้ dist/ โดยตรง, ระบบล่ม |
| **P1** | ผลกระทบสูง | INSERT ลง DB แบบไม่ IGNORE, ขาด Backoff |
| **P2** | ผลกระทบกลาง | ไม่ใส่ .js suffix ใน import |
| **P3** | ผลกระทบต่ำ | โค้ดสไตล์, ความเป็นระเบียบ |

### 8 หมวดรีวิว

1. **Correctness & Logic** — Logic ทำงานตรงตามระบบ Poller/Bidding, ใช้ `?.` และ `??` อย่างปลอดภัย
2. **Security** — P0: ห้าม read/print/commit secrets จาก `.env`
3. **Reliability & Error Handling** — ไม่กลืน exception, Fetch API ควรมี Exponential Backoff
4. **Performance** — query ไม่เกิดลูป, ไม่เก็บข้อมูลไม่จำเป็นใน memory
5. **Maintainability & Readability** — P2: ต้องมี `.js` suffix ใน import (NodeNext), SRP
6. **Architecture & Design** — P0: schema ไม่สอดคล้อง, P1: DB write ไม่ใช้ `INSERT IGNORE`
7. **Testing & Quality Gates** — ตรวจ logic เชิงลึกด้วยตา, ระวัง SQL migration ที่กระทบ runtime
8. **Compatibility & Deployment Risk** — DB Schema ต้องมี `.sql` ใหม่, ไม่แก้ root `poll-bidding.js`

## Step 6: Output Format + Auto-Fix

```markdown
🔍 Code Review: <branch-name>

PR: #<number> — <link>
สรุป: N ไฟล์ | N commits | +X/-Y lines

🔴 P0 Critical (ต้องแก้ก่อน merge)
- [ไฟล์:บรรทัด] ประเด็น | ผลกระทบ | วิธีแก้

🟠 P1 High (ควรแก้ก่อน merge)
- ...

🟡 P2 Medium (แก้เร็วๆ นี้)
- ...

🔵 P3 Low (nice to have)
- ...

🟢 Good Practices (ทำดีแล้ว)
- ...

✅ ผลสรุป: พร้อม merge / ต้องแก้ไข N รายการ
```

**Auto-Fix Loop:**
1. แก้ไขโค้ดที่พบปัญหา P0-P3 ทันที
2. รัน Build (`npm run build`)
3. Commit & Push
4. วนกลับ Step 5 (สูงสุด 3 รอบ)

## Step 7: Merge Gate

### ผ่าน (เคลียร์ P0-P3 หมดจด 100%)
1. **บังคับรัน Local Build**: `npm run build`
2. หากไม่ผ่าน → วนกลับ Step 5
3. Merge (`squash`)
4. Cleanup local branch

### ไม่ผ่าน (ยังมี P0-P3 หลัง 3 รอบ)
1. **ห้าม merge เด็ดขาด**
2. แจ้ง user เพื่อขอคำตัดสินใจ

## Reference

- [[Runbook-Deploy-Safety-Checklist]] — pre-push checks
- [[SPX-Project-Rules]] — coding standards
