# A3 initial two-host production cutover design

## Problem

The protected A3 deploy path assumes that each production host already owns an
immutable `spx-production` baseline. The live system predates that contract:

- the primary runs `spx-notifier-1` and `spx-worker-ptwl-1` under project `spx`;
- TEAM 2 runs `spx-worker-ifn-1` under project `spx` on `147.50.240.44`;
- both hosts use the same mutable legacy image digest and writable bind mounts;
- `/root/SPX` is a normal working directory, not an immutable release projection;
- role-specific A3 database principals and mounted runtime secret files are absent.

`production-project-identity.mjs` correctly refuses this state because adoption is
only a project-owner rename for an already identical immutable service set. The
first A3 cutover must therefore establish the immutable baseline and the split
topology in one separately reviewed transaction. It must keep the current workers
available until mutation begins and restore them exactly if either host fails.

## Chosen approach

Add a one-time, protected first-cutover path. It consumes the same attested release
and two signed target descriptors as later upgrades, plus an expiring approval that
binds the observed legacy baseline and the desired host-scoped candidate. The path
does not weaken the steady-state deploy admission rules.

The rollout has four phases:

1. **Prepare without service interruption.** Verify release and descriptor
   attestations, capture a fresh encrypted backup, provision exact-host TLS-only
   database principals, install root-only secret files, import the immutable image,
   and materialize release projections on both hosts.
2. **Preflight both hosts.** Compare the running legacy containers with the approved
   sanitized snapshot, render Compose with no missing variables, prove DB/TLS and
   notification-tunnel access, and create fsynced rollback journals. No legacy
   service is stopped during this phase.
3. **Cut over in order.** Stop the two primary legacy services, run the one-shot
   migrator, start the five primary A3 services, and require exact health and
   identity. Then stop the TEAM 2 legacy worker and start only
   `worker-ifn-split`. At no point may two workers own the same team.
4. **Commit or compensate.** Commit the primary `/root/SPX` immutable symlink only
   after both units are healthy. On any failure, stop TEAM 2 candidate services,
   restore its legacy worker, stop the primary candidate services, restore the two
   primary legacy services, and verify one healthy poller for each team.

## Approval and evidence

The first-cutover approval contains no credentials. It binds:

- release SHA, image tag and image ID;
- primary and TEAM 2 descriptor artifact hashes;
- exact legacy project, service set, image ID, config hashes, mounts, networks,
  ports, node IDs, team IDs, and health state;
- exact candidate project, service set, rendered config hashes, named volumes,
  networks, ports, node IDs, and team IDs;
- database account hosts and the digest of each sanitized grant proof;
- the backup evidence digest, maintenance window, operation order, health timeout,
  and rollback owner.

All comparisons use canonical JSON and SHA-256. Credential values, provider cookies,
email/password values, internal shared secrets, DB connection strings, and raw SQL
errors never enter logs or approval artifacts.

## Database and secret bootstrap

A root-only controller runs on the database host through the local MySQL socket. It
creates or rotates candidate accounts with random passwords, exact non-wildcard
account hosts, `REQUIRE SSL`, resource limits, and only the grants in
`deploy/db-grants.json`. It proves both required and forbidden capabilities before
writing a sanitized binding record.

Passwords are transferred directly into mode-`0400` files on the owning application
host. Primary and TEAM 2 receive only the credentials they need. Internal service
keys are independently generated, installed as root-owned regular files, and shared
only where the signed node-to-service policy requires the same value. The existing
database-encrypted team provider accounts remain unchanged.

The existing legacy DB account stays valid through the observation window. Its
revocation remains a separate post-proof action.

## Host transaction

Each host controller has `preflight`, `cutover`, `rollback`, `reconcile`, and
`verify` actions. It never runs arbitrary shell input from an approval. Compose
files, service names, projects, paths, image references, and timeouts are validated
against fixed allowlists and the signed descriptor.

The journal is written before the first Docker mutation and advances through
`prepared`, `legacy-stopped`, `candidate-started`, `healthy`, `committed`,
`rolling-back`, and `rolled-back`. A systemd watchdog reconciles every non-terminal
state after runner loss. Rollback uses `stop` and explicit `up --no-build --no-deps`
service lists; it never uses `down -v`, volume prune, network prune, or destructive
filesystem cleanup.

The primary retains the original `/root/SPX` directory under a root-only rollback
path. After both units pass, `/root/SPX` becomes an atomic symlink to the immutable
operator directory. TEAM 2 uses `/opt/spx-production-team2/current` and never owns
the primary projection.

## Safety invariants

- Exactly one poller owns TEAM 1 and exactly one poller owns TEAM 2.
- Primary is healthy before TEAM 2 mutation starts.
- TEAM 2 contains only `worker-ifn-split` and publishes no port.
- Only primary runs migrations and publishes `127.0.0.1:3000`.
- The TEAM 2 notification tunnel binds loopback locally and reaches the primary
  intake before its candidate worker starts.
- No mutable image reference or unverified source checkout participates in cutover.
- A failed or interrupted step converges to either the complete A3 pair or the exact
  legacy pair; mixed ownership is never accepted as terminal.

## Alternatives rejected

Recreating the legacy containers manually with a release tag would make the current
identity adoption pass only after an unjournaled mutation and would still leave the
service, secret, and DB-principal gaps. Disabling identity checks in the normal
deploy workflow would make every later upgrade less safe. Moving TEAM 2 onto the
primary would contradict the required independent-worker topology and reduce fault
isolation.

