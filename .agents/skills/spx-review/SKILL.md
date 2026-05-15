---
name: spx-review
description: Full PR flow — commit, branch, push, GitHub PR, strict 8-category code review, auto-fix, and merge. Use when the user invokes `$spx-review`, asks for review, or wants to review and merge code changes.
---

# /review — Full Code Review & Merge Flow

เมื่อ user สั่ง review ให้ดำเนินการตาม flow ทั้งหมดโดยอัตโนมัติ:

## When To Run

- User wants to review and merge code changes.
- User says "review", "PR", or "merge".

## Step 1: ตรวจ Uncommitted Changes

```bash
git status --porcelain
```

- มี uncommitted changes → commit ทันที (`git add -A && git commit -m "<conventional-commit>"`)
- ไม่มี changes → ตรวจ unpushed commits
- ไม่มีทั้งคู่ → แจ้ง "ไม่มีอะไรให้ review" แล้วหยุด

## Step 2: ตรวจ Branch

```bash
git branch --show-current
```

### อยู่บน `main` หรือ `master`:
1. นับ unpushed commits: `git log origin/<base>..HEAD --oneline`
2. ไม่มี → หยุด
3. มี → สร้าง branch: `<prefix>/<kebab-case-summary>`

### อยู่บน branch อื่น:
- ใช้ branch นั้นเลย

## Step 3: Push Branch

```bash
git push -u origin <branch-name>
```

## Step 4: สร้าง PR ผ่าน GitHub MCP

- ดึง owner/repo จาก `git remote get-url origin`
- **title**: สรุปสั้นๆ จาก commits (conventional commit style)
- **head**: `<branch-name>`
- **base**: `main` หรือ `master` (detect อัตโนมัติ)

## Step 5: Code Review 8 หมวด

Use the `$spx-strict-pr-review` skill for the full 8-category review with P0-P3 severity levels.

ขั้นตอน:
1. ดึง diff + file list
2. อ่านไฟล์ที่เกี่ยวข้องทั้ง context
3. รีวิว 8 หมวด + severity (P0-P3)
4. SPX-specific checks:
   - แก้ไขตรงๆ ใน `dist/` หรือปริ้นค่า secrets → P0
   - บันทึก DB โดยไม่ใช้ `INSERT IGNORE` → P1
   - Fetch API ขาด Exponential Backoff → P1
   - ไม่มี `.js` suffix ใน imports (NodeNext) → P2

## Step 6: แสดงผล + Auto-Fix

**Auto-Fix Loop:**
- พบ P0-P3 → แก้ทันที → commit → push → กลับ Step 5 (สูงสุด 3 รอบ)
- ไม่มี P0-P3 → ไป Step 7

## Step 7: Merge

- ไม่มี P0-P3 → merge ทันที (`squash`)
- ยังมี P0-P3 หลัง 3 รอบ → ถาม user

หลัง merge:
```bash
git checkout <base>
git pull origin <base>
git branch -d <branch-name>
```

แจ้ง: "✅ Merge เรียบร้อย! PR #<number> merged → <base>"

## Rules

- Base branch: detect อัตโนมัติ (main/master)
- merge conflict → ถาม user ว่าจะช่วย resolve ไหม
- ใช้ `agent: codex` ใน session log

## Reference

- `$spx-strict-pr-review` — detailed 8-category review criteria
- [[Runbook-Deploy-Safety-Checklist]] — pre-push checks
