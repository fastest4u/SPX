# Project Memory V2 — Active Guardrails & Architectural Rules

> Auto-generated from Project Memory V2 (`projectId: 310f00ba-ff0f-47bc-9430-a3a838647462`). Do not edit manually.

## Binding Architectural Decisions (ADRs)

- **[VERIFIED] SPX Dual-Storage Notify Rules and DB-Backed Live Settings**: SPX Dual-Storage Notify Rules and DB-Backed Live Settings: Keep notify-rules.json for local/non-DB development and MySQL notify_rules + app_settings with live reload in production. (`967289d0-6c07-46b6-a29b-94fcdcaf63bd`)
- **[VERIFIED] Execute F4 Live Cutover of SPX to Project Memory V2**: Execute F4 Live Cutover of SPX to Project Memory V2: Freeze C:/Users/Server/Desktop/SPX/memory as a verified read-only V1 archive (0o444) and activate the event-sourced Project Memory V2 store at C:/Users/Server/Desktop/SPX/memory-v2. (`5802428e-7186-47b1-9522-3de73b0bdba1`)

## Past Mistakes to Avoid

- **[VERIFIED] Avoid Duplicate LINE Image Listeners and Stale Message Replays**: Avoid Duplicate LINE Image Listeners and Stale Message Replays: Starting LINE image listeners on both notifier and line-service or processing historical messages on reconnect causes duplicate OCR replies. (`aede5dc0-ddac-4ff1-826e-f3379c15fefe`)
