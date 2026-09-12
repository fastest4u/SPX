# Recover verification under provider rate limits

Approved in conversation: fix both teams using durable read-only retries, shared provider cooldown, conservative ownership/quota and restart recovery. No commit, push, migration on production, or deploy is requested.

The live detached verifier must never convert missing tab evidence into a loss. Positive status 2 proves ownership; contradictory or incomplete evidence stays pending. Unknown requests retain their dedupe and quota until settled. Retries only read provider state, never replay accept POSTs.

Persist a verification intent before each detached accept POST and update its response after the POST. An interrupted POST is recovered as ambiguous. Store only job/business metadata, never cookies or passwords. A dedicated verification queue table has per-team trace identity, pending request state, next attempt, attempt count and a fenced lease. Team poller startup restores holds before accepting new work; recurring recovery works independently of the booking cooldown. Shutdown/pause prevents new verification reads and leaves durable work recoverable.

Settle newly resolved requests atomically with canonical results, history and rule progress so a crash or repeated read cannot decrement quota twice. Keep per-request outcomes for mixed batches. Notification publication must use stable identities; external delivery uses the existing notification subsystem. Historical indeterminate rows can be imported for read-only recovery without replaying acceptance.

All provider reads on one ApiClient share cooldown and verification priority. HTTP 429 and provider retcode 130008001 extend the cooldown, honoring Retry-After. Backoff plus jitter prevents a retry storm; unrelated teams remain independent. Do not add external dependencies or change provider authentication.

Verification: reproduce partial/unreadable cases first; test retry-to-success, restart, duplicate recovery, mixed results, DB failure, team isolation, lease loss, long-lived quota holds, and no repeated accept POST. Run focused local tests and TypeScript checks; no live provider acceptance.
