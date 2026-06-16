---
description: Full PR flow — commit, branch, push, GitHub MCP PR + strict-pr-review-8-category review, auto-fix, merge. Use when the user wants to review and merge code changes.
---

# /review — Full Code Review & Merge Flow

เมื่อ user สั่ง `/review` ให้อ่าน skill `strict-pr-review-8-category` แล้วดำเนินการตาม flow ทั้งหมดโดยอัตโนมัติ:

// turbo-all

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
3. มี → สร้าง branch:
   - ตั้งชื่อจาก commit: `fix/`, `feat/`, `refactor/`, `cleanup/`, `test/` + kebab-case
   ```bash
   git checkout -b <branch-name>
   git checkout <base>
   git reset --hard origin/<base>
   git checkout <branch-name>
   ```

### อยู่บน branch อื่น:
- ใช้ branch นั้นเลย

## Step 3: Push Branch

```bash
git push -u origin <branch-name>
```

## Step 4: สร้าง PR ผ่าน GitHub MCP

ดึง owner/repo จาก `git remote get-url origin`:
- ใช้ `mcp_github-mcp-server_create_pull_request`
- **title**: สรุปสั้นๆ จาก commits (conventional commit style)
- **head**: `<branch-name>`
- **base**: `main` หรือ `master` (detect อัตโนมัติ)
- **body**: สรุปเป็นภาษาไทย ตาม template ใน skill

## Step 5: Code Review 8 หมวด

**ใช้ skill:** `strict-pr-review-8-category` — Step 5

ขั้นตอน:
1. ดึง diff + file list + CI status ผ่าน GitHub MCP
2. อ่านไฟล์ที่เกี่ยวข้องทั้ง context
3. รีวิว 8 หมวด + severity (P0-P3) อิงตามบริบทของ SPX (Node.js/TypeScript)
4. ตรวจ project-specific checks (SPX):
   - มีการแก้ไขตรงๆ ใน `dist/` หรือมีการอ่านปริ้นค่า secrets → P0
   - บันทึก Database โดยไม่ใช้ `INSERT IGNORE` (กรณี request history) → P1
   - Fetch API ขาดการทำ Exponential Backoff หรือลืม handle Retry → P1
   - ไม่มี `.js` suffix ใน imports ของไฟล์ TypeScript ตามระบบ NodeNext → P2

## Step 6: แสดงผล + Auto-Fix

แสดงผลภาษาไทยตาม format ใน skill

**Auto-Fix Loop:**
- พบ P0-P3 → แก้ทันที → commit → push → กลับ Step 5 (สูงสุด 3 รอบ)
- ไม่มี P0-P3 → ไป Step 7

## Step 7: Merge

- ไม่มี P0-P3 → merge ผ่าน GitHub MCP ทันที
- ยังมี P0-P3 หลัง 3 รอบ → ถาม user

ใช้ `mcp_github-mcp-server_merge_pull_request`:
- **merge_method**: `squash`
- **commit_title**: `<PR title> (#<number>)`

หลัง merge:
```bash
git checkout <base>
git pull origin <base>
git branch -d <branch-name>
```

แจ้ง: "✅ Merge เรียบร้อย! PR #<number> merged → <base>"

## หมายเหตุ

- Base branch: detect อัตโนมัติ (main/master)
- GitHub MCP tools ที่ใช้:
  - `create_pull_request` — สร้าง PR
  - `pull_request_read` — ดู PR details, diff, files, check runs
  - `merge_pull_request` — merge PR
- merge conflict → ถาม user ว่าจะช่วย resolve ไหม
