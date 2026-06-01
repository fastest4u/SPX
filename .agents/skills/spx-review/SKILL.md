---
name: spx-review
description: Unified SPX review-and-fix workflow. Creates or updates a PR, runs strict 8-category review, auto-fixes all findings, pushes fixes, and auto-merges when clean. Use when the user invokes `$spx-review`, asks to review code, or wants a PR created and reviewed.
---

# SPX Review

Single-mode skill: every invocation runs the **full pipeline** — PR → review → auto-fix → push → auto-merge (if clean).

## Ground Rules

- Use local `git` commands for workspace state: status, diff, branch, commit, push.
- Use GitHub MCP for all remote PR operations: create/read/update PRs, read diff/files/checks/comments, request Copilot review, update branch, submit review, merge.
- Do not use `gh` CLI, web UI, or browser fallback unless the user explicitly approves.
- If GitHub MCP is unavailable or unauthenticated, stop and report the blocker.
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

4. Use GitHub MCP to find or create the PR:
   - Search for an existing PR with `list_pull_requests` using the branch head.
   - If none exists, create one with `create_pull_request`.
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
# merge via GitHub MCP
merge_pull_request with merge_method: squash
```

หลัง merge สำเร็จ → cleanup branch:

```bash
git checkout <base>
git pull origin <base>
git branch -d <branch-name>
```

แจ้งผู้ใช้ว่า merge สำเร็จแล้ว. ไม่ deploy หลัง merge ยกเว้นผู้ใช้สั่งโดยตรง.

### ถ้าไม่ผ่านเงื่อนไข → หยุดและรายงาน

แจ้งผู้ใช้ว่าเงื่อนไขข้อใดยังไม่ผ่าน พร้อมรายละเอียด และรอคำสั่ง.

## Step 7: Post-Merge Production Check

หลัง merge สำเร็จ ให้ทำ **production verification แบบ read-only** เสมอ เพื่อไม่ให้จบงานทั้งที่ server ยังรัน commit เก่า:

1. ตรวจ local/remote base head:

```bash
git rev-parse --short HEAD
git log --oneline -n 3
```

2. ตรวจ production server แบบไม่พิมพ์ secrets:

```bash
ssh root@45.83.207.139 "cd /root/SPX && git rev-parse --short HEAD && git log --oneline -n 3"
ssh root@45.83.207.139 "docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'"
```

3. ถ้า change มี runtime/env behavior ให้ตรวจ container bundle และ runtime config เฉพาะ key ที่เกี่ยวข้องเท่านั้น เช่น:

```bash
ssh root@45.83.207.139 "docker exec spx-app-1 printenv BIDDING_VEHICLE_TYPE || true"
ssh root@45.83.207.139 "docker exec spx-app-1 sh -c 'cd /app && grep -c BIDDING_VEHICLE_TYPE dist/app.js || true'"
```

4. ถ้ามี DB/runtime effect ให้ query แบบ read-only เฉพาะ aggregate/sample ที่ไม่เปิดเผย secrets เช่น count by `vehicle_type`, recent rows, หรือ app setting key ที่เกี่ยวข้อง.
5. ถ้า production server ยังไม่ตรงกับ merged commit ให้รายงานเป็น **deployment pending** พร้อมหลักฐาน commit/container/runtime.
6. ห้าม deploy/restart เอง เว้นแต่ user สั่งชัดเจนว่า deploy/restart/ship production.

เมื่อ user สั่ง deploy/restart ชัดเจน:

1. อ่าน deploy files ก่อน (`docker-compose.yml`, deploy scripts, README deploy notes).
2. รัน deploy ตาม pattern repo/server ปัจจุบัน.
3. ตรวจซ้ำว่า server git head, container image/build, health, runtime key, และ behavior สำคัญตรงกับ change.
4. บันทึกผลใน memory session log.

## Step 8: Session End

หลังจบ pipeline:

1. รัน verification gate ที่เหมาะสม.
2. เรียก project-memory `memory_sessionEnd`.
3. บันทึกผลลัพธ์, ไฟล์ที่แก้ไข, verification, decisions, และ open follow-ups.
