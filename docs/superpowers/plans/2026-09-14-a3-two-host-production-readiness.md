# A3 two-host production readiness implementation plan

**Goal:** Make the protected A3 release package match the current production placement: TEAM 1 and the HTTP/notification/LINE/OCR control plane on the primary host, and exactly one TEAM 2 worker on `147.50.240.44`.

**Architecture:** Keep one immutable A3 release and shared MySQL. Add a reviewed, release-bound topology manifest that names every service, team, node, Compose project, migration owner, and cross-host notification route. The primary host owns migrations and public readiness. TEAM 2 reaches the existing primary loopback notification ingress through its already managed private tunnel, so the endpoint stays compatible during forward and reverse rollout. Runtime leases remain the final duplicate-poller fence.

## Constraints

- Do not read or copy `.env` values.
- Do not mutate production, GitHub secrets, databases, or containers in this implementation pass.
- Keep TEAM 1 assigned only to the primary host and TEAM 2 assigned only to the designated remote host.
- Keep migrations and Gate 6 database ownership on the primary host only.
- Require explicit service names for every Compose action; never use a broad profile startup.
- Keep the protected workflow bootstrap-denied until the trusted workflow bodies, topology manifest, host facts, and pins are independently reviewed.
- Use TDD for executable behavior and run the full repository verification gate before calling the patch ready.

## Task 1: Release-bound two-host topology contract

- [x] Add a failing test for a strict production topology parser and the checked-in two-host manifest.
- [x] Require two exact deployment units (`primary`, `team2`), one migration owner, non-overlapping team IDs, unique node IDs, explicit services, and the six-service split baseline distributed across the two hosts.
- [x] Reject duplicate pollers, a TEAM 2 worker on the primary, a TEAM 1 worker on TEAM 2, public ports on TEAM 2, unsafe notification routes, unknown fields, and mutable/ambiguous Compose commands.
- [x] Add the validator CLI and include both the validator and manifest in the immutable operator bundle.

## Task 2: Host-specific Compose projections

- [x] Add a primary overlay that keeps the notification ingress private and contains no remote worker activation.
- [x] Add a TEAM 2 overlay that binds `worker-ifn-split` to TEAM 2, a unique node ID, and a required loopback notification URL supplied by the managed tunnel.
- [x] Validate the merged Compose models without rendering secret values.

## Task 3: Protected deployment workflow integration

- [x] Make the protected installer derive the primary service list from the release-bound topology contract instead of the old six-service same-host literal.
- [x] Add a bootstrap-denied, SHA-pinned remote-worker protected workflow that consumes the same immutable release and signed target facts, checks host identity, deploys only TEAM 2, verifies image/role/team/node/lease freshness, and records rollback evidence.
- [x] Orchestrate primary installation before TEAM 2 so each host has a tested, bounded local rollback path and the primary cannot activate a second TEAM 2 poller.
- [x] Provenance-attest the TEAM 2 deployment result against the same release and target descriptor, and require both host jobs before the dispatcher succeeds.

## Task 4: One-time legacy adoption and operations

- [x] Add a fail-closed adoption mode for the current two-host legacy baseline that materializes immutable rollback projections without changing team placement, database schema, or provider targets.
- [x] Document exact forward, rollback, lease-drain, tunnel, readiness, and observation checks for both hosts.
- [x] Keep production activation blocked until GitHub environments, immutable pins, target facts, backup/restore proof, staging fault drills, and Gate 1-6 evidence are present.

## Verification

- [x] Focused RED/GREEN tests for the topology contract and workflow source.
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm test`
- [x] `npm run build`
- [x] Read-only Compose configuration checks for both host projections.
