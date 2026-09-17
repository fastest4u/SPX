---
name: spx-prod-status
description: Inspect live production status, health checks, container states, and polling logs across both SPX production hosts (Primary 45.83.207.139 and Worker 147.50.240.44). Use when the user invokes `$spx-prod-status`, asks to check production status, asks if pollers are running, or wants a health check of both servers.
---

# SPX Production Status

Unified diagnostic workflow to check the live health, container status, and polling performance across both SPX production servers.

## Ground Rules

- **Read-only**: Run only non-mutating inspection commands (`docker ps`, `curl`, `df`, `free`, `docker logs`).
- **Never expose secrets**: Do not print, grep, or cat `.env`, database passwords, secret keys, or token values.
- **SSH Key**: Always pass `-i C:\Users\Server\.ssh\id_ed25519 -o StrictHostKeyChecking=no` when executing SSH commands from Windows.
- **Report language**: สรุปรายงานสถานะระบบทั้งหมดเป็น**ภาษาไทย**.

---

## Step 1: Inspect Primary Host (`45.83.207.139`)

Runs Web API Dashboard, Central LINE Notification Dispatcher, Database Migrations, and Poller Team 1 (PTWL).

```bash
ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@45.83.207.139 "
  echo '=== GIT HEAD ===' && cd /root/SPX && git rev-parse --short HEAD &&
  echo '=== CONTAINERS ===' && docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' &&
  echo '=== SYSTEM RESOURCES ===' && df -h / && free -m &&
  echo '=== API HEALTH ===' && curl -s http://127.0.0.1:3000/ready
"
```

Expected healthy indicators:
- `spx-notifier-1`: Up (healthy)
- `spx-worker-ptwl-1`: Up (healthy)
- API `/ready`: `{"status":"success","data":{"ready":true,"service":"web-api","state":"ok",...}}`
- Disk `/`: Free space > 20%
- Memory: Available RAM > 200MB

---

## Step 2: Inspect Worker Host (`147.50.240.44`)

Runs Poller Team 2 (IFN).

```bash
ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@147.50.240.44 "
  echo '=== CONTAINERS ===' && docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' &&
  echo '=== SYSTEM RESOURCES ===' && df -h / && free -m
"
```

Expected healthy indicators:
- `spx-worker-ifn-1`: Up (healthy)
- Disk `/`: Free space > 20%
- Memory: Available RAM > 200MB

---

## Step 3: Inspect Real-Time Polling Activity

Check the recent logs from both pollers to confirm active communication with SPX:

```bash
# Team 1 Poller Logs (Primary Host)
ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@45.83.207.139 "docker logs --tail 15 spx-worker-ptwl-1"

# Team 2 Poller Logs (Worker Host)
ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@147.50.240.44 "docker logs --tail 15 spx-worker-ifn-1"
```

Analyze the logs for:
- `requesting`: Requests are firing actively.
- `poll-status`: Returning `same` or `changed`.
- `rate-limit-backoff`: Normal 2-second rate-limiting backoffs by SPX (`retcode=130008001`) are handled gracefully without container crash.
- No uncaught exceptions or crash loops.

---

## Step 4: Summary Report (ภาษาไทย)

สรุปสถานะให้ผู้ใช้ทราบในรูปแบบ:

```markdown
### รายงานสถานะ SPX Production (2-Host Topology)

1. **เครื่องหลัก (Primary Host: 45.83.207.139)**:
   - Commit: `<short-sha>`
   - Containers:
     - `spx-notifier-1`: Up (healthy) ✅
     - `spx-worker-ptwl-1`: Up (healthy) ✅
   - API / Dashboard: พร้อมใช้งาน (Ready: true) ✅
   - Disk / RAM: ปกติ (เหลือ X GB / X MB)

2. **เครื่อง Worker (Team 2 Host: 147.50.240.44)**:
   - Container:
     - `spx-worker-ifn-1`: Up (healthy) ✅
   - Disk / RAM: ปกติ (เหลือ X GB / X MB)

3. **สถานะการ Polling**:
   - Team 1 (PTWL): กำลังดึงงานปกติ (Request #N, Latency X ms)
   - Team 2 (IFN): กำลังดึงงานปกติ (พบ N bookings / Request #N)
```
