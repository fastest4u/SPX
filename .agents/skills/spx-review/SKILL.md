---
name: spx-review
description: Unified SPX review-and-fix workflow. Creates or updates a PR, runs strict 8-category review, auto-fixes all findings, pushes fixes, and auto-merges when clean. Use when the user invokes `$spx-review`, asks to review code, or wants a PR created and reviewed.
---

# SPX Review

Single-mode skill: every invocation runs the **full pipeline** — PR → review → auto-fix → push → auto-merge (if clean).

## Ground Rules

- Use local `git` commands for workspace state: status, diff, branch, commit, push.
- Use GitHub MCP for remote PR operations by default.
- If GitHub MCP is unavailable and the user explicitly approves CLI fallback, use GitHub CLI (`gh`) for PR operations: create/read/update PRs, read diff/files/checks/comments, update branch, and merge.
- Do not use web UI or browser fallback unless the user explicitly approves.
- If neither GitHub MCP nor an explicitly approved `gh` CLI fallback is available/authenticated, stop and report the blocker.
- Never read, print, copy, or commit `.env` secret values. Do not edit `dist/`, `data/`, `logs/`, `node_modules/`, generated route trees, or secrets.
- Review only issues introduced by the current diff. Do not raise unrelated pre-existing issues unless made worse by the change.
- **Report language**: สรุป issue ทั้งหมดเป็น**ภาษาไทย** รวมถึงชื่อปัญหา, ผลกระทบ, และวิธีแก้ไข (เฉพาะชื่อไฟล์/โค้ดคงเป็นภาษาอังกฤษ).
- Use `agent: codex` in memory session logs.

## Step 1: Memory And Risk Check

1. Run project-memory session/context/follow-up checks required by `AGENTS.md`.
2. Run `spx-self-check` before production-impacting work, DB schema changes, notifications, auto-accept, auth, secrets, deploy, or broad `src/services/` or `src/controllers/` changes.
3. Carry relevant open follow-ups into the final response or session end.

## Step 2: Discover Local State

```bash
git status --porcelain
git branch --show-current
git remote get-url origin
git log --oneline --decorate -n 20
```

Detect `owner/repo` from `origin`. Detect the base branch by checking `main` first, then `master`.

If the worktree has unrelated dirty files, do not stage them. Stage only files that are clearly in scope. If scope is ambiguous, ask the user.

## Step 3: Prepare Branch, Commit, And PR

1. If currently on `main` or `master`, create a topic branch: `feat/<kebab-summary>` or `fix/<kebab-summary>`.
2. Stage and commit only scoped changes with a conventional commit message.
3. Push the topic branch:

```bash
git push -u origin <branch-name>
```

4. Use GitHub MCP, or explicitly approved `gh` CLI fallback, to find or create the PR:
   - Search for an existing PR using the branch head.
   - If none exists, create one.
   - If one exists, use that PR for the rest of the pipeline.
   - Do not create duplicate PRs.

## Step 4: Strict 8-Category Review

Before reviewing:

1. Get the full diff and file list (local `git diff` or GitHub MCP `get_files` / `get_diff`).
2. Read the surrounding function/class/module context, not only the changed lines.
3. Compare behavior against SPX project rules and runtime config in executable code.

### Severity Levels

| ระดับ | ความหมาย | ตัวอย่าง |
| --- | --- | --- |
| P0 | วิกฤต — ต้องแก้ก่อน merge | secret หลุด, แก้ไฟล์ `dist/` โดยตรง, runtime crash, schema/runtime ไม่ตรงกันจนพัง production |
| P1 | ผลกระทบสูง | เขียน DB ไม่ปลอดภัย, ไม่มี retry/backoff ตอนเรียก API ภายนอก, ข้อมูลหาย, notification/auto-accept เสีย |
| P2 | ผลกระทบปานกลาง | import ไม่มี `.js` suffix ใน NodeNext, migration ครอบคลุมไม่ครบ, type/runtime ไม่ตรงกัน |
| P3 | ผลกระทบต่ำ | maintainability, style, naming, ขาด test เล็กน้อย |

### Review Categories

1. **ความถูกต้องและ Logic**: พฤติกรรม poller/bidding, edge cases, nullish handling, idempotency.
2. **ความปลอดภัย**: secrets, auth, token handling, logs, `.env`, sensitive payloads.
3. **ความเสถียรและ Error Handling**: retries, exponential backoff, timeouts, exception handling, partial failures.
4. **ประสิทธิภาพ**: DB/query loops, memory growth, polling frequency, avoid unnecessary work.
5. **Maintainability และอ่านง่าย**: local patterns, strict TypeScript, NodeNext `.js` import suffixes, clear ownership.
6. **สถาปัตยกรรมและ Design**: repository/service boundaries, schema compatibility, no generated/runtime artifact edits.
7. **Testing และ Quality Gates**: focused checks for touched behavior, migration/runtime risk, typecheck/build results.
8. **Compatibility และความเสี่ยง Deploy**: env compatibility, migrations, dashboard/API contract, production restart/deploy implications.

### SPX-Specific Blockers

- แก้ไข `dist/`, generated files, หรือ commit secret values: P0.
- อ่านหรือพิมพ์ secret values จาก `.env`: P0.
- บังคับใช้ Protected A3 requirements (เช่น บังคับ TLS certificate verify-identity, notification node secret rings) เมื่อระบบรันในโหมด `legacy` ตาม `deploy/runtime-deployment-contract.json`: P0 (จะทำให้ container startup แครชบน production).
- เขียน DB ที่ควร idempotent แต่ไม่ได้ทำ: P1.
- เรียก API ภายนอกโดยไม่มี retry/backoff ที่เหมาะสม: P1.
- import ใน TypeScript ไม่มี `.js` suffix ภายใต้ NodeNext: P2.

## Step 5: Auto-Fix And Report

### 5a. Auto-Fix Loop

1. แก้ไข findings ทั้งหมด P0–P3 ในไฟล์ที่อยู่ใน scope.
2. ถ้า finding มีความคลุมเครือทางธุรกิจ ให้หยุดถามแทนที่จะเดา.
3. รัน `npm run typecheck` หลังแก้ไขแต่ละรอบ.
4. Review diff ใหม่ทั้งหมดหลังแก้ไขแต่ละรอบเพื่อยืนยันว่าไม่มี regression.
5. ทำซ้ำได้สูงสุด **3 รอบ** ถ้ายังแก้ไม่หมดหลัง 3 รอบ ให้รายงานเป็น unresolved.
6. Commit fix และ push:

```bash
git add <fixed-files>
git commit -m "fix: <summary of review fixes>"
git push
```

### 5b. Final Verification

รัน `npm run build` เพื่อยืนยันว่า build ผ่านหลังแก้ไขทั้งหมด.

### 5c. Report (ภาษาไทย)

รายงานผลลัพธ์เป็น**ภาษาไทย** เรียงตามความรุนแรง ทุก finding ต้องมีหลักฐาน file/line/function และผลกระทบ.

```markdown
## สรุปผล Review: <branch-or-pr>

**PR:** #<number>
**ภาพรวม:** N ไฟล์ | N commits | +X/-Y บรรทัด

### P0 วิกฤต
- [file:line] ปัญหา | ผลกระทบ | แก้ไขแล้ว ✅ / ยังไม่แก้ ❌

### P1 ผลกระทบสูง
- ...

### P2 ผลกระทบปานกลาง
- ...

### P3 ผลกระทบต่ำ
- ...

### แนวปฏิบัติที่ดี
- ...

### ผลลัพธ์
- พบปัญหา: N รายการ, แก้แล้ว: N, ยังไม่แก้: N
- Build: ✅ ผ่าน / ❌ ไม่ผ่าน
- พร้อม merge: ใช่ / ไม่ (เหตุผล)
```

ถ้าไม่พบ finding ให้แจ้งชัดเจนและระบุความเสี่ยง test หรือ deployment ที่เหลืออยู่.

## Step 6: Auto-Merge

หลังจาก Step 5 เสร็จ ให้ตรวจสอบเงื่อนไข merge อัตโนมัติ:

### เงื่อนไข Auto-Merge (ต้องผ่านทุกข้อ)

1. **ไม่มี finding P0–P3 ค้างอยู่** (แก้หมดแล้ว หรือไม่มีตั้งแต่แรก).
2. `npm run build` ผ่าน.
3. GitHub check runs/status ผ่าน หรือไม่มี CI configured.
4. PR ไม่มี unresolved review threads.

### ถ้าผ่านทุกเงื่อนไข → Merge อัตโนมัติ

```bash
# merge via GitHub MCP or approved gh CLI fallback
gh pr merge <number> --squash --delete-branch
```

หลัง merge สำเร็จ → cleanup branch:

```bash
git checkout <base>
git pull origin <base>
git branch -d <branch-name>
```

> **Auto Deploy Notice:** เมื่อ merge เข้า `main` ระบบ GitHub Actions จะเริ่มกระบวนการ Build & Auto Deploy ไปยังเซิร์ฟเวอร์ทั้งสองเครื่องโดยอัตโนมัติทันที

### ถ้าไม่ผ่านเงื่อนไข → หยุดและรายงาน

แจ้งผู้ใช้ว่าเงื่อนไขข้อใดยังไม่ผ่าน พร้อมรายละเอียด และรอคำสั่ง.

## Step 7: Post-Merge Auto-Deploy & Two-Host Production Check

หลัง merge สำเร็จ เฝ้าติดตาม GitHub Actions CI/CD และตรวจสอบ production ทั้งสองเครื่อง:

### 7a. Monitor GitHub Actions Auto Deploy

```bash
# ตรวจสอบ workflow run ล่าสุดบน main
gh run list --limit 1
# เฝ้าติดตามการ deploy จนเสร็จสิ้นครบทั้ง 4 ขั้นตอน
gh run watch <run-id>
```

4 ขั้นตอนของ CI/CD pipeline:
1. `Build Check`: Typecheck, lint, build, test (385 tests)
2. `Preflight TEAM 2 on 147.50.240.44`: SSH check
3. `Deploy API and TEAM 1 on primary host`: Deploy `45.83.207.139`
4. `Deploy TEAM 2 on 147.50.240.44`: Deploy `147.50.240.44`

### 7b. Two-Host Production Verification (Read-Only)

ตรวจสถานะ production ทั้งสองโฮสต์ด้วย SSH key `C:\Users\Server\.ssh\id_ed25519`:

1. **เครื่องหลัก (Primary Host: `45.83.207.139`)**:
   - Web API, Notifier, Database Migrations, Poller Team 1 (PTWL)
   ```bash
   ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@45.83.207.139 "cd /root/SPX && git rev-parse --short HEAD && docker ps --format 'table {{.Names}}\t{{.Status}}' && curl -s http://127.0.0.1:3000/ready"
   ```
   Containers ที่ต้องรัน: `spx-notifier-1`, `spx-worker-ptwl-1` (ต้องขึ้น `Up (healthy)`)

2. **เครื่อง Team 2 (Worker Host: `147.50.240.44`)**:
   - Poller Team 2 (IFN)
   ```bash
   ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@147.50.240.44 "docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'"
   ```
   Container ที่ต้องรัน: `spx-worker-ifn-1` (ต้องขึ้น `Up (healthy)`)

3. **ตรวจสอบ Polling Logs**:
   ```bash
   # ตรวจ Team 1
   ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@45.83.207.139 "docker logs --tail 15 spx-worker-ptwl-1"
   # ตรวจ Team 2
   ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@147.50.240.44 "docker logs --tail 15 spx-worker-ifn-1"
   ```

4. สรุปผลการ deploy และสถานะ production ทั้งสองเครื่องให้ผู้ใช้ทราบเป็นภาษาไทย.

## Step 8: Session End

หลังจบ pipeline:

1. รัน verification gate ที่เหมาะสม.
2. เรียก project-memory `memory_sessionEnd`.
3. บันทึกผลลัพธ์, ไฟล์ที่แก้ไข, verification, decisions, และ open follow-ups.
