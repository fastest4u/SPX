---
name: spx-prod-status
description: Inspect live production status, health checks, container states, and polling logs across all 3 SPX production hosts (Primary 45.83.207.139, Worker 1 147.50.240.44, and Worker 2 45.154.26.83). Use when the user invokes `$spx-prod-status`, asks to check production status, asks if pollers are running, or wants a health check of all servers.
---

# SPX Production Status

Unified diagnostic workflow to check the live health, container status, and polling performance across all 3 SPX production servers (3-Node Distributed Topology).

## Ground Rules

- **Read-only**: Run only non-mutating inspection commands (`docker ps`, `curl`, `df`, `free`, `docker logs`).
- **Never expose secrets**: Do not print, grep, or cat `.env`, database passwords, secret keys, or token values.
- **SSH Key**: Always pass `-i C:\Users\Server\.ssh\id_ed25519 -o StrictHostKeyChecking=no` when executing SSH commands from Windows.
- **Report language**: สรุปรายงานสถานะระบบทั้งหมดเป็น**ภาษาไทย**.

---

## Step 1: Inspect Primary Host (`45.83.207.139`)

Runs Web API Dashboard, Central LINE Notification Dispatcher, Database Migrations, and Dedicated Poller for **Team 3 (KRTK)** (`spx-worker-krtk-1`).

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
- `spx-worker-krtk-1`: Up (healthy)
- `spx-line-service-1`: Up (healthy)
- API `/ready`: `{"status":"success","data":{"ready":true,"service":"web-api","state":"ok",...}}`
- Disk `/`: Free space > 20%
- Memory: Available RAM > 200MB

---

## Step 2: Inspect Worker 1 Host (`147.50.240.44`)

Runs Dedicated Poller for **Team 2 (IFN)** (`spx-worker-ifn-1`) with direct MySQL connection to `210.246.215.212:3306`.

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

## Step 3: Inspect Worker 2 Host (`45.154.26.83` AMD EPYC)

Runs Dedicated Poller for **Team 1 (PTWL)** (`spx-worker-ptwl-1`) with direct MySQL connection to `210.246.215.212:3306`.

```bash
ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@45.154.26.83 "
  echo '=== CONTAINERS ===' && docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' &&
  echo '=== SYSTEM RESOURCES ===' && df -h / && free -m
"
```

Expected healthy indicators:
- `spx-worker-ptwl-1`: Up (healthy)
- Disk `/`: Free space > 20%
- Memory: Available RAM > 200MB

---

## Step 4: Inspect Real-Time Polling Activity

Check recent logs from both remote workers to confirm active polling and direct DB access:

```bash
# Team 1 Poller Logs (Worker 2 Host: 45.154.26.83)
ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@45.154.26.83 "docker logs --tail 15 spx-worker-ptwl-1"

# Team 2 Poller Logs (Worker 1 Host: 147.50.240.44)
ssh -o StrictHostKeyChecking=no -i C:\Users\Server\.ssh\id_ed25519 root@147.50.240.44 "docker logs --tail 15 spx-worker-ifn-1"
```

Analyze the logs for:
- `requesting`: Requests are firing actively.
- `poll-status`: Returning `same` or `changed`.
- `rate-limit-backoff`: Normal 2-second rate-limiting backoffs by SPX (`retcode=130008001`) are handled gracefully without container crash.
- No uncaught exceptions or crash loops.

---

## Step 5: Summary Report (ภาษาไทย)

สรุปสถานะให้ผู้ใช้ทราบในรูปแบบ:

```markdown
### รายงานสถานะ SPX Production (3-Node Distributed Topology)

1. **เครื่องหลัก Web API & Central Notifier (Primary: 45.83.207.139)**:
   - Commit: `<short-sha>`
   - Containers:
     - `spx-notifier-1`: Up (healthy) ✅
     - `spx-line-service-1`: Up (healthy) ✅
   - API / Dashboard: พร้อมใช้งาน (Ready: true) ✅
   - Disk / RAM: ปกติ (เหลือ X GB / X MB)

2. **เครื่อง Worker 1 (Team 2 IFN: 147.50.240.44)**:
   - Container:
     - `spx-worker-ifn-1`: Up (healthy) ✅ (Direct MySQL)
   - Disk / RAM: ปกติ (เหลือ X GB / X MB)

3. **เครื่อง Worker 2 (Team 1 PTWL: 45.154.26.83 AMD EPYC)**:
   - Container:
     - `spx-worker-ptwl-1`: Up (healthy) ✅ (Direct MySQL)
   - Disk / RAM: ปกติ (เหลือ X GB / X MB)

4. **สถานะการ Polling**:
   - Team 1 (PTWL @ 45.154.26.83): กำลังดึงงานปกติ (Request #N, Latency X ms)
   - Team 2 (IFN @ 147.50.240.44): กำลังดึงงานปกติ (พบ N bookings / Request #N)
```
