# 2026-05-17 Temporary Server Stop

## Summary
- SSH checked production Docker state on `root@45.83.207.139`.
- Stopped the SPX app container `spx-app-1` temporarily.
- Verified `docker ps` is empty and `spx-app-1` is `Exited (0)`.

## Scope
- No database, config, secret, or source file changes were made on the server.
- This was an operational stop only.

## Verification
- `ssh ... "docker ps --format ..."` returned no running containers.
- `ssh ... "docker ps -a --filter name=spx-app-1 --format ..."` returned `spx-app-1   Exited (0)`.

## Follow-up: Server Restart
- Restarted `spx-app-1` after the temporary stop.
- Verified `docker ps --filter name=spx-app-1 --format ...` returned `Up ... (healthy)` with `127.0.0.1:3000->3000/tcp`.
- Verified `docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' spx-app-1` returned `running healthy`.
