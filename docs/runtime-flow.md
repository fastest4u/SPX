---
title: Runtime Flow
tags:
  - obsidian
  - spx
  - runtime
aliases:
  - ลำดับการทำงาน
---

# Runtime Flow

## Startup Sequence

```mermaid
sequenceDiagram
  participant CLI as CLI Args
  participant App as app.ts
  participant Env as env.ts
  participant Admin as user-repository
  participant Poller as Poller
  participant HTTP as HTTP Server
  participant DB as MySQL

  CLI->>App: interval (seconds)
  App->>Env: validateRuntimeConfig()
  Env->>Env: Load .env → validate all required vars
  
  alt HTTP_ENABLED
    App->>Admin: createAdminUserIfNotExists()
    Admin->>DB: ensureDashboardTables()
    Admin->>DB: INSERT admin user (if not exists)
  end

  App->>Poller: new Poller(interval)
  App->>Poller: start()
  
  Poller->>Poller: formatHeader() → log start info
  
  alt HTTP_ENABLED
    Poller->>HTTP: startHttpServer(port)
  end
  
  alt SAVE_TO_DB
    Poller->>DB: ensureMetricsTable()
    Poller->>Poller: Start metrics timer (every 5 min)
  end
  
  Poller->>Poller: Begin poll loop
```

## Tick Flow (แต่ละรอบ polling)

1. **Request counter** เพิ่มขึ้น
2. **ApiClient.fetch()** เรียก `POST /booking/bidding/list`
3. ถ้า request ล้มเหลว:
   - Error ถูก classify (`session_expired`, `network`, `rate_limited`, etc.)
   - Metrics updated, tick ends
4. ถ้า request สำเร็จ:
   - **DataProcessor.detectChange()** — FNV-1a hash comparison
   - **formatStatus()** — log summary (bookings count, change status)
   - ถ้า `FETCH_DETAILS` | `SAVE_TO_DB` | `NOTIFY_ENABLED`:
     - Fetch request list per booking (3 concurrent via `Promise.all`)
     - **extractAllRequestListTrips()** — แปลง API response → `ExtractedTripInfo[]`
     - Print trip info ถ้า `FETCH_DETAILS`
   - ถ้า `SAVE_TO_DB`:
     - `INSERT IGNORE` each trip → `spx_booking_history`
   - ถ้า `AUTO_ACCEPT_ENABLED`:
     - **matchAutoAcceptRuleTrips()** → accept via API → notify
   - ถ้า `NOTIFY_ENABLED`:
     - **notifyMatchedRules()** → Discord/LINE

## Tick Flow Diagram

```mermaid
sequenceDiagram
  participant P as Poller
  participant API as SPX API
  participant DP as DataProcessor
  participant EC as Error Classifier
  participant DB as MySQL
  participant RE as Rule Engine
  participant N as Notifier

  P->>API: POST /booking/bidding/list
  
  alt Failure
    API-->>P: Error response
    P->>EC: classifyPollingError()
    EC-->>P: {category, retryable, message}
    P->>P: Record metrics + log
  else Success
    API-->>P: Booking list
    P->>DP: detectChange(data)
    DP-->>P: {hasChanged, hash}
    
    opt Need details
      loop Each booking (3 concurrent)
        P->>API: POST /booking/bidding/request/list
      end
      
      opt SAVE_TO_DB
        P->>DB: INSERT IGNORE per trip
      end
      
      opt AUTO_ACCEPT
        P->>RE: matchAutoAcceptRuleTrips()
        RE-->>P: matches[]
        P->>API: POST /booking/bidding/accept
        P->>N: notify success/failure
      end
      
      opt NOTIFY_ENABLED
        P->>RE: matchRules()
        P->>N: send Discord/LINE
      end
    end
  end
```

## Shutdown Sequence

1. `SIGINT` หรือ `SIGTERM` triggers `Poller.stop()`
2. Stop poll timer (`clearTimeout`)
3. Stop metrics persistence timer (`clearInterval`)
4. Persist ==final metrics snapshot== ก่อน shutdown
5. Wait for active tick to complete (if any)
6. `formatFooter()` — print final stats
7. Stop HTTP server
8. Close MySQL pool
9. `process.exit(exitCode)`

## Error Handling Style

> [!tip] Key Principles
> - **Non-fatal polling errors** → log + skip tick → retry next interval
> - **Duplicate DB saves** → treated as "skipped", not errors
> - **Notification failures** → channels are independent (Discord fail ≠ LINE fail)
> - **Shutdown failures** → logged before forced exit
> - **Session expiry** → classified, logged as `session_expired` category

## Metrics Persistence

> [!note] New Feature
> Metrics ถูก persist ลง DB ทุก 5 นาที + ก่อน shutdown
> - ป้องกัน data loss หลัง restart
> - Query ผ่าน `GET /metrics/history?limit=100`
> - Table: `metrics_snapshots`

## ดูเพิ่มเติม
- [[architecture]] — Component map
- [[error-handling]] — Error classification details
- [[database-schema]] — Table structures
- [[notification-system]] — Notification flow
