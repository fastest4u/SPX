# A3 initial two-host production cutover implementation plan

## Task 1: Keep immutable release validation executable

- Add a release-workflow regression asserting that the dependency-locked Chromium
  binary is installed after `npm ci` and before `npm test`.
- Run the release workflow on the merged commit and retain only the attested artifact
  from the passing run.

## Task 2: Add production DB-principal bootstrap

- Add failing tests for exact-host account planning, role allowlists, SQL parameter
  separation, TLS/resource limits, grant minimization, forbidden capability proofs,
  credential redaction, idempotency, and compensation.
- Implement a root-socket production provisioner that consumes
  `deploy/db-grants.json`, generates random credentials, emits only canonical
  sanitized binding evidence, and writes encrypted or root-only transfer bundles.
- Add host-side installation of per-role `binding.json`, candidate/legacy password
  files, and active projections with atomic writes and strict ownership/modes.

## Task 3: Add runtime secret materialization

- Add tests for an exact primary/TEAM 2 secret manifest, cross-service shared-key
  equality, unique per-node credentials, root-only file modes, atomic replacement,
  and output redaction.
- Implement a one-time secret generator/installer and a canonical
  `/etc/spx-production/runtime.env` writer that contains paths and public identifiers
  only.
- Preserve the existing `SECRETS_KEY` bytes and DB-encrypted team/provider settings.

## Task 4: Add the first-cutover host controller

- Add failing state-machine tests for primary and TEAM 2 preflight, ordered service
  stop/start, exact health checks, no duplicate team poller, commit, rollback after
  every mutation boundary, and crash reconciliation.
- Implement a fixed-command Docker adapter and a durable journal with fsync and
  atomic state transitions.
- Bind candidate verification to the attested release, signed descriptor, approval,
  image ID, Compose hashes, node/team identities, volumes, networks, and ports.
- Commit the immutable primary projection only after both deployment units report
  healthy terminal evidence.

## Task 5: Add protected two-host orchestration

- Add workflow contract tests before creating a dispatcher and pinned reusable
  workflow for the one-time cutover.
- Verify release and descriptor attestations, protected approval digests, SSH host
  keys, target identity hashes, backup evidence, and exact workflow identity before
  SSH.
- Preflight both hosts, cut over primary then TEAM 2, compensate in reverse order,
  and upload sanitized terminal evidence.
- Keep the normal protected deploy workflows unchanged and bootstrap-denied until
  their own prerequisites pass.

## Task 6: Review and release

- Run focused tests, lint, typecheck, build, full tests, audit, and the strict SPX
  eight-category review.
- Open a focused PR, resolve every finding, wait for green CI, merge, and build a new
  immutable release from the merge commit.
- Generate and sign primary/TEAM 2 target facts and first-cutover approval from fresh
  live sanitized inventory.

## Task 7: Execute production cutover

- Capture a fresh encrypted backup and isolated restore proof.
- Provision DB principals and runtime secrets while the legacy services remain
  healthy.
- Run read-only preflight on both hosts and record the rollback journals.
- Cut over primary, verify five exact services and TEAM 1 lease ownership, then cut
  over TEAM 2 and verify its single TEAM 2 lease owner.
- Observe provider polling, auto-accept verification recovery, notification delivery,
  dashboard readiness, restart counts, rate-limit metrics, and duplicate-worker
  inventory.
- Retain legacy rollback material and DB credentials through the observation window;
  revoke them only through the separately approved post-proof action.

