---
title: Deployment
tags:
  - obsidian
  - spx
  - deployment
  - docker
aliases:
  - การ Deploy
  - Production Setup
---

# A3 two-host candidate deployment reference

> This is the default-off protected A3 runbook for the production placement already used operationally: the control plane and TEAM 1 on the primary host, with one TEAM 2 worker on `147.50.240.44`. Use [the current deployment runbook](deployment.md) for the currently released runtime. No A3 rollout is implied by local validation.
>
> In a source checkout use `Dockerfile.a3` and `docker-compose.a3.yml`. The A3 release workflow selects `--topology=a3`; the verified operator archive projects these reviewed bytes to its canonical `Dockerfile` and `docker-compose.yml`. Installed commands below use that canonical archive path. The source checkout's released files are preserved. The manual dispatcher is `.github/workflows/a3-deploy.yml`.

The runtime deployment contract is `protected-a3`. A regular build includes it in
`dist/deployment-contract.json`; the legacy CI workflow reports deployment deferred
and never enters its primary or remote-worker jobs for this runtime. The legacy
Dockerfile and worker installer reject it explicitly. Use this protected release
path to supply the build manifest, matching release manifest, target descriptor and
deployment context together. Do not change the contract to `legacy` to bypass the
node HMAC, schema or split LINE service requirements.

Normal protected production upgrades use one immutable release with two signed target
descriptors. The `primary` descriptor authorizes the five primary services and the
`team2` descriptor authorizes only `worker-ifn-split` on `147.50.240.44`. The previous
runtime must support the candidate schema before image load or migration. First
adoption requires exactly one verified legacy TEAM 2 worker; the remote installer
stops that container before it starts the protected worker and restores it if
activation fails. A stale lease or missing heartbeat alone is not retirement
evidence. Stop failures abort activation, and verified image loading precedes
dependency extraction so installation also works without a pre-existing image cache.

## Local candidate execution admission (2026-09-12)

New job payloads must explicitly declare `executionMode: "cutover"` before real execution or settlement may perform business side effects. Omitted publisher mode defaults to `shadow`, whose idempotency key uses a separate `shadow:` namespace while executable keys remain canonical. A current publication epoch proves producer/generation ownership; it does not prove execution intent.

Every historical payload lacking executionMode is quarantined as `indeterminate` with `legacy_job_admission_ambiguous`, including epoch-bound rows. Explicit shadow jobs claimed by real workers are cancelled with `shadow_job_not_executable`. Quarantine retains payload, winning attempt trace, canonical result and settlement checkpoints. Inspect those records and authoritative provider outcomes before any separately reviewed recovery; never infer intent from the epoch or blindly add a cutover marker. A canonical child/parent collision with an unadmitted historical row is retained for reconciliation, not silently promoted or treated as successfully published.

## Local Run

```bash
npm install
npm run build       # backend (esbuild) + frontend (vite) → dist/
npm start -- 10     # start with 10s interval
```

> [!note] Frontend Build
> `npm run build` จะสร้างทั้ง backend (`dist/app.js`) และ frontend (`dist/public/index.html` + assets)
> Backend จะ serve SPA จาก `dist/public/` โดยอัตโนมัติเมื่อ `HTTP_ENABLED=true`

> [!important] Database Migrations
> ถ้า `HTTP_ENABLED=true` หรือ `SAVE_TO_DB=true` ต้อง run migration ก่อน startup:
>
> ```bash
> npm run db:migrate
> ```
>
> ใน production runtime ตรวจ exact released migration history แบบ read-only และจะไม่ทำ DDL เอง
> ต้องให้ one-shot migrator สำเร็จก่อนเริ่ม service ทุกครั้ง ส่วน runtime DDL compatibility
> คงไว้เฉพาะ non-production เท่านั้น

## Development Mode

```bash
# Backend only (ts-node)
npm run dev:backend -- 10

# Frontend only (Vite dev server with proxy)
npm run dev:frontend

# Both backend + frontend (concurrently)
npm run dev
```

## Smoke Test

```bash
npm run smoke:test
```

> [!note] ต้อง start app ก่อน
> Smoke test ต้องการ app ที่ทำงานอยู่บน `http://127.0.0.1:3000`
> ตรวจ `/ready` และ static assets

## Docker

### Immutable Release And Manual Deploy

Production and staging deployment is artifact-driven. The target host is not a Git checkout and never builds the application image.

1. Dispatch `.github/workflows/release-artifact.yml` with one operator-approved 40-character `source_sha`. Its unprivileged build job runs the candidate gates and builds the image once. Its privilege-bearing job can only call full-SHA-pinned `.github/workflows/trusted-release-artifact.yml`; that protected reusable workflow checks out its own trusted SHA, re-verifies the inert candidate tuple, attests every subject, and publishes the immutable release artifact ID. New releases declare schema minimum `33` because signed internal intake requires `internal_request_replays`.
2. Create two protected, signed production target descriptors for the same release: `deployment_unit=primary` and `deployment_unit=team2`. Their topology, host/database facts, canonical paths, image identity, release-manifest digest, and operator-bundle digest must match the release tuple. Staging accepts only `deployment_unit=primary`.
3. Dispatch `.github/workflows/a3-deploy.yml` with `target`, `release_artifact_id`, `target_descriptor_artifact_id`, and, for production, `team2_target_descriptor_artifact_id`. There is no branch, run ID, topology, Compose project, or identity-adoption override.
4. The primary deploy verifies the immutable release and primary descriptor, migrates once, and activates only the five services assigned to the primary host. After that job succeeds, the TEAM 2 deploy independently verifies the same release and its TEAM 2 descriptor, then uploads a checksum-bound payload over the pinned TEAM 2 SSH identity.
5. Each host uses its own mutation lock and local verified rollback. A successful TEAM 2 install emits `team2-deployment.json`, binds the release/image/descriptor/container identities, and receives GitHub build-provenance attestation from the pinned trusted workflow. The dispatcher succeeds only after both jobs succeed. If the second host restores its previous release after a failure, keep the run failed and dispatch the previously approved release plus both of its descriptors to return both hosts to one release deliberately.

Mutable jobs that delegate environment, OIDC, attestation, or host credentials never
execute steps or request an environment themselves. Deploy, project-identity, and
staging-approval dispatchers are call-only. Release and descriptor request workflows
may build inert candidate artifacts in separate unprivileged jobs, but their
privilege-bearing jobs can only call reusable workflows through
`fastest4u/SPX/.github/workflows/<workflow>@<40-character-sha>`. Branch, tag, and
local `./.github/workflows/...` references are forbidden for these calls.

`BOOTSTRAP-DENY` is an intentional zero-SHA sentinel. A new trusted workflow cannot
pin the commit that introduces itself, so bootstrap is a reviewed two-stage change:

1. Commit and review the trusted reusable workflows while every request workflow
   still points at the zero SHA. Production requests must fail to resolve in this
   state.
2. Record that commit's full SHA, independently verify the trusted workflow files at
   that commit, then make a second change that replaces all six foundational zero-SHA pins with
   that same immutable SHA. Do not change the trusted workflow bodies in the pin
   change.
3. Set the protected trusted-workflow SHA variables to that reviewed commit and keep
   environment approval or deployment-protection rules configured to reject any job
   whose reusable workflow identity is not the approved full SHA.

GitHub environment secrets are not workflow-scoped: any job that is allowed to
reference the environment can request them after its protection rules pass. The
production environment therefore needs a deployment-protection check that validates
the reusable `job_workflow_ref`/`job_workflow_sha`, or the static SSH key must be
replaced by a short-lived credential broker whose OIDC policy enforces those claims.
Required reviewers must reject a request whose call chain is not the pinned reusable
workflow. The repository YAML alone cannot enforce this platform-side rule.

Never replace the sentinel with `main`, a tag, a local workflow reference, or the SHA
of a commit that does not contain all six foundational trusted reusable workflows. Until the
stage-two pin change and protected-environment configuration are complete, release
signing, deployment, descriptor signing, staging rollout signing, and project-identity
maintenance remain intentionally disabled.

#### Protected-evidence producer bootstrap

`deploy/protected-evidence-producers.json` is the independently reviewed trust map for
the six protected-evidence routes. Every entry starts with the all-zero 40-character
`signerSha`, the all-zero 64-character `workflowFileSha256`, and
`bootstrapDenied: true`. The matching public request remains pinned to
`@0000000000000000000000000000000000000000`, so none of these routes can produce an
artifact during the bootstrap change:

| Protected evidence kind | Public request | Exact protected producer | Exact artifact files |
| --- | --- | --- | --- |
| `staging-gates` | `staging-protected-evidence.yml` | `trusted-staging-protected-evidence.yml` | `staging-protected-evidence.json` |
| `production-backup-restore` | `production-backup-restore.yml` | `trusted-production-backup-restore.yml` | `production-backup-restore-evidence.json`, `production-backup-restore-signature.json` |
| `protected-install` | `a3-deploy.yml` | `trusted-deploy.yml` | `protected-install-evidence.json`, `protected-install-signature.json` |
| `accepted-db-transition` | `gate6-accepted-evidence.yml` with the DB-transition phase | `gate6-accepted-evidence-exporter.yml` | `accepted-db-transition-evidence.json` |
| `accepted-pre-close` | `gate6-accepted-evidence.yml` with the pre-close phase | `gate6-accepted-evidence-exporter.yml` | `accepted-pre-close-evidence.json` |
| `final-verifier` | `gate6-final-verifier.yml` | `gate6-final-verifier-exporter.yml` | `final-verifier.json` |

The runbook treats these as six zero-SHA dispatcher routes across five public workflow
files. The two accepted-evidence kinds share one step-free dispatcher and exporter,
but remain separate map entries with different exact filenames and semantic bindings.
The TEAM 2 deployment result is a separate provenance-attested operational artifact
from `trusted-team2-deploy.yml`; the complete A3 dispatcher remains failed unless both
the primary protected install and this remote result succeed for the same release.
Enable the six routes only with this reviewed **three-commit activation**; a single
pin-and-map change is self-referential because each consumer checks out the map from
its own `job.workflow_sha`:

1. **Producer SHA A:** commit and independently review the final protected producer
   and consumer workflow bodies while every dispatcher pin and map digest remains zero
   and every map entry remains bootstrap denied. Reproduce each protected producer
   workflow file SHA-256 from this exact commit.
2. **Map/consumer SHA B:** in a second commit, populate each map entry with producer
   SHA A and that producer file's digest, then set `bootstrapDenied` to `false`. Do not
   change producer workflow bodies and keep every public dispatcher at the zero SHA.
   This commit is the immutable consumer snapshot: when invoked later, the consumer
   checks out map/consumer SHA B and can authorize the earlier producer SHA A without
   referring to a commit that does not yet exist.
3. **Dispatcher activation SHA C:** after independent review of B, make a dispatcher-only
   commit. Point the five protected producer dispatchers (`deploy`, staging protected
   evidence, backup/restore, accepted evidence, and final verifier) to producer SHA A.
   Point the Gate 6 envelope, LINE, OCR, post-proof, and runtime consumer dispatchers to
   map/consumer SHA B. Do not change producer bodies, consumer bodies, or the map in C.
4. Bind producer protected-environment SHA settings to A and consumer signer/runtime
   SHA settings to B before allowing C to run. Consumers verify the artifact's REST
   `workflow_run.id` and repository/head identity, the immutable attestation certificate
   `runInvocationURI`, mapped workflow/digest/environment, subject digest, and exact file
   set. A copied, replayed, or manually re-uploaded JSON file is not an authorized
   substitute even if its bytes have an older valid attestation.

The production backup route has additional host bootstrap prerequisites. The
production owner, independently of this repository, must install and attest the exact
regular root-owned executables `/usr/bin/mysqldump`, `/usr/bin/mysql`,
`/usr/bin/docker`, and `/usr/local/libexec/spx-kms-envelope`, then pin all four
digests in the protected context. The owner must also provision the read-only
capability files: the source capability at
`/run/credentials/spx-production-backup-source.cnf` and the least-privilege KMS
capability at `/run/credentials/spx-production-backup-kms.json`. Both must be
root-owned mode-`0400` files with independently pinned digests. Do not enable
the backup dispatcher until the protected host inventory attests those executables
and capabilities. The workflow never installs the KMS helper, synthesizes a KMS
policy, or receives source/KMS capability values through dispatch inputs.

Protected environment configuration required by these workflows includes:

- `SPX_TRUSTED_DEPLOY_WORKFLOW_SHA`, `SPX_TRUSTED_TEAM2_DEPLOY_WORKFLOW_SHA`, `SPX_TRUSTED_RELEASE_WORKFLOW_SHA`, `SPX_TRUSTED_DESCRIPTOR_SIGNER_SHA`, `SPX_TRUSTED_STAGING_SIGNER_SHA`, `SPX_DESCRIPTOR_SIGNER_FILE_SHA256`, `STAGING_SIGNER_WORKFLOW_SHA256`, and `SPX_TRUSTED_IDENTITY_WORKFLOW_SHA`
- `SPX_DESCRIPTOR_KEY_ID`, `SPX_DESCRIPTOR_PUBLIC_KEY_B64`, `SPX_DESCRIPTOR_OIDC_AUDIENCE`, and `SPX_TARGET_FACTS_SHA256`
- `SPX_APPROVED_PRODUCTION_TOPOLOGY`, `SPX_TARGET_HOST_IDENTITY_SHA256`, `SPX_TEAM2_TARGET_HOST_IDENTITY_SHA256`, `SPX_KNOWN_HOSTS_SHA256`, and `SPX_TEAM2_KNOWN_HOSTS_SHA256`
- `SPX_DESCRIPTOR_TARGET_FACTS_B64`/`SPX_TARGET_FACTS_SHA256` for the primary target and `SPX_DESCRIPTOR_TEAM2_TARGET_FACTS_B64`/`SPX_DESCRIPTOR_TEAM2_TARGET_FACTS_SHA256` for TEAM 2
- `SPX_PRODUCTION_CANDIDATE_IDENTITY_APPROVAL_B64` and its exact `SPX_PRODUCTION_CANDIDATE_IDENTITY_APPROVAL_SHA256`; this approval is bound to the candidate release SHA, image tag/ID, service set, Compose config, volumes, networks, ports, health thresholds, maintenance window, and rollback owner
- `SPX_HOST`, `SPX_PORT`, `SPX_USER`, `SPX_SSH_KEY`, and pinned `SPX_KNOWN_HOSTS` for the primary host
- `SPX_TEAM2_HOST`, `SPX_TEAM2_PORT`, `SPX_TEAM2_USER`, `SPX_TEAM2_SSH_KEY`, and pinned `SPX_TEAM2_KNOWN_HOSTS` for `147.50.240.44`

For the current release, `SPX_APPROVED_PRODUCTION_TOPOLOGY` must be exactly `split`.

### Staging final production-observer prerequisites

The protected `SPX_DESCRIPTOR_TARGET_FACTS_B64` value is the only source of the
staging production-observer trust anchor. Its target facts must include
`target.productionObserverPolicySha256` as the lowercase SHA-256 of the exact
canonical UTF-8 policy bytes, with ordered keys and no trailing newline:

```json
{"endpoint":"https://observer.example/internal/ready","schemaVersion":1}
```

That endpoint is an example only. The real HTTPS endpoint, GET-only bearer token,
and `spx_stg_phase3_observer` password are protected deployment material. Operators
must provision them through the approved protected-capability process; they must not
be committed, added to the operator bundle, printed, copied into evidence, or passed
through a dispatch input. The descriptor signer runs the strict target-facts
validator before requesting OIDC, and staging facts fail closed unless signed
`database.accountHosts` exactly covers the provisioned role set with an exact,
non-wildcard `phase3-observer` host. Production descriptors require the policy hash
to be `null`.

The final Gate 4 observer uses these distinct final-only installed paths:

```text
/etc/spx-staging/phase3-production-observer-policy.json
/run/spx-staging-actions/phase3-production-observer-token
/run/spx-staging-actions/database/principal-phase3-observer.password
```

They do not replace `/etc/spx-staging/production-observer.json` or the continuous
guard token, and provisioning them must not modify `capacity.env`, either capacity
unit or process, or any guard/watchdog lease. Trusted deploy accepts these files only
inside the separately protected staging capability tar. Before extraction or any
fixed-path rename, the code-owned archive validator requires a bounded ustar archive
with the exact authoritative database-role file set, one `database/` directory,
regular single-link leaves, and no duplicate, traversal, link, PAX/GNU, or special
entry. It then validates the canonical signed policy, untrimmed token, observer
password, action capability, CA hash, exact role set, and equality with the existing
continuous observer endpoint.

All five protected targets (database directory, CA, final policy, final token, and
action capability) are staged and backed up on their destination filesystems before
the first swap. The action capability activates last. Both early validation failure
and later runtime rollback use the same idempotent protected-file restore, with the
action capability restored last; prior hashes and modes are rechecked and paths that
did not previously exist are removed. Backups remain until the whole deployment
succeeds. No guard/watchdog service is restarted. There is intentionally no manual
secret installation or evidence-editing shortcut.

Gate 4 calls `collectInstalledPhase3CapacityEvidence()` with no arguments. That
final-only collector authenticates the installed staging descriptor and capability,
requires the original finite guard baseline and the same fresh guard/watchdog lease
instances before and after collection, verifies the local default Docker context and
release labels, and checks the exact `spx_stg_phase3_observer` account/host and grants
on one TLS MySQL connection. The final policy hash is verified before the token is
opened and the same policy inode/bytes are rechecked after the bounded GET and
capacity reads. Its recursively frozen output contains only sanitized measurements,
the approved-versus-fixed threshold split, signed policy hash, readiness/p95 response,
and derived booleans; it never contains the endpoint, token, password, DB target,
grants, raw rows/body, or the admission-only staging-port field.

### Gate 4 Phase 3 evidence closure

The protected rollout controller is the only supported live entry point for Gate 4:

```bash
npm run --silent service:a3-staging-rollout-controller -- gate-4-phase3
```

Run it only after Gate 0R and Gates 1-3 plus the eight Phase 3 actions have completed
for the same installed release, approval, canary team/epoch, and guard/watchdog lease
instances. The controller freezes the pre-Gate-4 journal at the action 23
`phase3-inline-owner-restore` terminal, while action 24 `staging-gate-4-phase3` is
still registered and unconsumed. The exact 44-action/90-record snapshot is persisted
before evidence collection at:

```text
/var/lib/spx-staging-rollout/evidence/phase3-snapshot/journal-snapshot.json
```

Gate 4 requires exactly ten immutable marker files. The first eight are mutation
measurements under `/var/lib/spx-staging-rollout/phase3-action-measurements/`:

```text
phase3-consumer-start-disabled.json
phase3-legacy-lease-release.json
phase3-poller-start.json
phase3-publication-enable.json
phase3-execution-enable.json
phase3-publication-fence.json
phase3-drain-or-quarantine.json
phase3-inline-owner-restore.json
```

The remaining two are read-only observations under
`/var/lib/spx-staging-rollout/phase3-observations/`:

```text
phase3-schema-verify.json
phase3-fence-ack-wait.json
```

The controller then materializes exactly five independently hashed final runtime
sources under `/var/lib/spx-staging-rollout/evidence/phase3-sources/`:

```text
db-final.json
runtime-final.json
lease-continuity.json
capacity.json
production-observer.json
```

Database collection uses only the validated `spx_stg_phase3_observer`
column-scoped SELECT-only principal over TLS. It has no schema or DDL privileges,
must not acquire a mutation-capable principal, and must not write
application/control rows. Production-observer collection instead uses the
authenticated, policy-bounded GET-only credential described above and does not
use a database principal. The fixed snapshot,
ten markers, and five runtime sources are bound into the semantic artifact at
`/var/lib/spx-staging-rollout/evidence/phase3-staging/phase3-rollout-evidence.json`.

The evidence producer runs inside that same controller call before the Gate 4
checker. It writes these exact 15 proof paths, in contract order:

```text
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/schema-verify.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/consumer-start-disabled.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/legacy-lease-release.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/poller-start.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/publication-enable.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/execution-enable.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/publication-fence.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/fence-acknowledged.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/drain-or-quarantine.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/inline-owner-restore.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/baseline-restored.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/phase3-durable-evidence.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/release-binding.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/guard-continuity.json
/var/lib/spx-staging-rollout/evidence/gates/proofs/staging-gate-4-phase3/production-unchanged.json
```

Only after all proofs exist does it write the aggregate
`/var/lib/spx-staging-rollout/evidence/gates/gate-4.json`, reload the same fresh
guard/watchdog leases as `Lpre`, and allow action 24 consumption. The controller's
initial `L0`, pre-consumption `Lpre`, and the checker's final in-handler reload must
all identify the same lease instances and agree with the persisted
`lease-continuity.json` source. The checker verifies every proof hash and the
semantic source graph before the handler records the Gate 4 terminal.

After action 24 advances the live journal, the Task 4 semantic verifier owns the
later-head check: it authenticates the saved action 23 snapshot head as an exact
prefix of the current journal head. Neither the semantic artifact nor its proofs may
be rewritten to claim the later terminal. If any source, installed release,
capability, observer policy, database grants, Compose configuration, threshold, or
other rollout configuration changes, discard the run's evidence and restart Gate 0R
and Gates 1-4; rerunning Gate 4 alone is not sufficient.

The root-owned `/etc/spx-staging/staging-rollout-trust.json` policy must pin
`workflowSha` for `staging-rollout-signer.yml` separately from the candidate release
SHA. Its `workflowFileSha256` still binds the exact signer bytes in the operator
bundle. Staging provenance and GitHub attestations must match the pinned signer SHA;
the signed release fields independently bind the candidate SHA.

The production host must have `spx-production-mutation-reconciler.service` installed and enabled, a root-owned non-writable `/etc/spx-production/runtime.env`, and a previously adopted `/root/SPX` immutable release projection. Normal deploys run project identity `verify` only. Use the separately protected `.github/workflows/production-project-identity.yml` for supervised legacy `spx` to canonical `spx-production` adoption or rollback; that workflow cannot load a candidate image or run migrations.

An active `adopting`, `installing`, `recovering`, or uncompensated host-lock record blocks another operation even after the GitHub workflow stops. Do not delete the lock directory manually. Inspect the reconciler and rollback journal, then let the reconciler record the terminal postcondition.

```bash
ACTIVE_RELEASE="$(readlink -f /root/SPX)"
printf '%s\n' "$ACTIVE_RELEASE" | grep -Eq '^/root/spx-releases/[0-9a-f]{40}/operator$'
RELEASE_PARENT="$(dirname "$ACTIVE_RELEASE")"
test "$(stat -c %u "$ACTIVE_RELEASE")" = 0
test -z "$(find "$ACTIVE_RELEASE" -maxdepth 0 -perm /022 -print)"
test -f "$RELEASE_PARENT/deployment-context.json"
test -f "$RELEASE_PARENT/release-manifest.json"
test -f "$RELEASE_PARENT/deployment-target-descriptor.json"
export SPX_IMAGE="$(node -e '
  const context = require(process.argv[1]);
  if (!/^spx-app:[0-9a-f]{40}$/.test(context.imageTag ?? "")) process.exit(1);
  process.stdout.write(context.imageTag);
' "$RELEASE_PARENT/deployment-context.json")"
export SPX_RELEASE_MANIFEST_PATH="$RELEASE_PARENT/release-manifest.json"
export SPX_TARGET_DESCRIPTOR_PATH="$RELEASE_PARENT/deployment-target-descriptor.json"
export SPX_DEPLOYMENT_CONTEXT_PATH="$RELEASE_PARENT/deployment-context.json"
SPX_EXPECTED_IMAGE_ID="$(node -e '
  const context = require(process.argv[1]);
  if (!/^sha256:[0-9a-f]{64}$/.test(context.imageId ?? "")) process.exit(1);
  process.stdout.write(context.imageId);
' "$RELEASE_PARENT/deployment-context.json")"
SPX_EXPECTED_MANIFEST_SHA256="$(node -e '
  const context = require(process.argv[1]);
  if (!/^[0-9a-f]{64}$/.test(context.releaseManifestSha256 ?? "")) process.exit(1);
  process.stdout.write(context.releaseManifestSha256);
' "$RELEASE_PARENT/deployment-context.json")"
test "$(docker image inspect --format '{{.Id}}' "$SPX_IMAGE")" = "$SPX_EXPECTED_IMAGE_ID"
test "$(sha256sum "$SPX_RELEASE_MANIFEST_PATH" | awk '{print $1}')" = "$SPX_EXPECTED_MANIFEST_SHA256"
spx_production_compose() {
  test "$(docker image inspect --format '{{.Id}}' "$SPX_IMAGE")" = "$SPX_EXPECTED_IMAGE_ID" || return 1
  test "$(sha256sum "$SPX_RELEASE_MANIFEST_PATH" | awk '{print $1}')" = "$SPX_EXPECTED_MANIFEST_SHA256" || return 1
  docker compose -p spx-production \
    --project-directory /root/SPX \
    --env-file /etc/spx-production/runtime.env \
    -f /root/SPX/docker-compose.yml \
    -f /root/SPX/deploy/production-primary.yml "$@"
}
spx_production_compose --profile migration run --rm migrator
spx_production_compose --profile split up -d \
  web-api notification-service line-service ocr-service \
  worker-ptwl-split
```

Run the preamble in the same root shell before any manual production Compose command. It refuses a mutable checkout or a release path outside the immutable projection and binds Compose to the installed image and release manifest. Do not replace `spx_production_compose` with a default-project command.

### Docker Image Details

- Production Compose pulls the exact digest in `SPX_IMAGE`; the target host never builds application source.
- Image metadata exposes the split-service HTTP ports: `3000`, `3002`, `3003`, `3004`, and internal realtime port `3005`
- Healthcheck ยิง `GET /ready` อัตโนมัติที่ `HTTP_PORT` ของ process นั้น
- Base image: digest-pinned `node:24-alpine`; runtime user is unprivileged `node`.
- Every container has a read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, bounded PID/CPU/memory, and a private `/tmp` tmpfs.
- Compose does not load or mount `.env` and does not share `./data`. `/etc/spx-production/runtime.env` contains only non-secret routing, identity, and secret-file paths. The immutable image and release manifest identities come from the verified release context; secret values stay in the referenced files.
- Every DB-backed production runtime and standalone DB evidence script requires a certificate-SAN DNS name in `DB_HOST` plus `DB_SSL_MODE=verify-identity` with the stable PEM CA path in `DB_SSL_CA_FILE`; IP literals, plaintext, and permissive TLS are rejected.
- The protected deploy workflow materializes both isolation validators from the signed operator bundle, never from the candidate image. The host-side `container-inventory-check.mjs` derives the exact bind, named-volume, secret/config bind, and tmpfs inventory from `docker compose config --format json`, then compares it with a narrow `docker inspect` result and `runtime-isolation-policy.json`. It validates the created migrator before that same container starts and validates every selected runtime container before readiness polling.
- Inventory failures expose only the service name and fixed failure codes. Missing or undeclared mounts, wrong source/target/type/access, changed tmpfs options, and Compose-policy drift all fail closed. The deploy error trap removes an unstarted migrator and rolls the runtime back before a release can be recorded healthy.
- The separate in-container `container-isolation-probe.mjs` still checks the migrator before migration and every selected service after readiness for UID, secret/config readability, root-filesystem, and path-access policy violations. Any failure reaches the same rollback path.

### Rollback-Only Legacy Services

The Compose file retains three legacy services only so the trusted rollback path can
restart a previously installed immutable release. The current image must not be
deployed with this topology: production `SPX_ROLE=notifier` requires a remote LINE
service and the trusted deploy accepts `SPX_APPROVED_PRODUCTION_TOPOLOGY=split` only.

| Service       | Role                                | Responsibility                                                                                            |
| ------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `notifier`    | `SPX_ROLE=notifier`                 | Rollback-only legacy service for previously installed images; current production candidates are split-only |
| `worker-ifn`  | `SPX_ROLE=worker`, `RUN_TEAM_IDS=2` | IFN polling/auto-accept worker                                                                            |
| `worker-ptwl` | `SPX_ROLE=worker`, `RUN_TEAM_IDS=1` | PTWL polling/auto-accept worker                                                                           |

Workers in a previous legacy release call that release's notifier over Docker networking. Notification events use `/internal/notification-events`; runtime telemetry uses `/internal/runtime-metrics`.

### Split-Service Two-Host Production Topology

`deploy/production-topology.json` is the release-bound placement contract. The primary
host owns migrations, the public web listener, internal notification/LINE/OCR services,
and TEAM 1. The remote host owns only TEAM 2 and publishes no port. Both units use the
Compose project name `spx-production`, but their Compose files and host mutation locks
are independent.

Run the signed one-shot migrator on the primary host before application rollout.
Secret-file paths in `/etc/spx-production/runtime.env` must point to role-specific files
prepared by the approved secret-distribution procedure. Stop every legacy primary
service first, then name the five primary services explicitly:

```bash
spx_production_compose stop notifier worker-ifn worker-ptwl
spx_production_compose --profile split up -d \
  web-api notification-service line-service ocr-service \
  worker-ptwl-split
```

Target topology:

| Unit | Host | Services | Published ports | Migrations |
| --- | --- | --- | --- | --- |
| `primary` | `45.83.207.139` | `line-service`, `notification-service`, `ocr-service`, `web-api`, `worker-ptwl-split` | `127.0.0.1:3000:3000` | yes |
| `team2` | `147.50.240.44` | `worker-ifn-split` with `RUN_TEAM_IDS=2` and node `prod-worker-ifn-node2` | none | no |

TEAM 2 uses only `deploy/production-team2.yml`. Its required
`SPX_TEAM2_NOTIFICATION_API_URL` is exactly
`http://127.0.0.1:3000/internal/notification-events`; a separately managed private SSH
tunnel maps that loopback listener to the primary notification intake. Validate the
tunnel before activation and keep it supervised outside Compose. The topology parser
rejects a public TEAM 2 port, a second worker, another notification URL, or migration
ownership on that host.

The signed TEAM 2 target facts must use these exact canonical paths:

```text
releaseRoot:    /opt/spx-production-team2
environmentFile: /etc/spx-production/runtime.env
stateRoot:      /var/lib/spx-production-team2-rollout
```

Only `web-api` should be published through nginx/public ports. Keep `notification-service`, `line-service`, and `ocr-service` on internal Docker network ports unless an operator intentionally exposes them for a private admin network.

The ad-hoc `/api/line-bot/send` test route and its frontend controls are disabled in
production. Production LINE delivery must originate from the durable notification
outbox so provider reservation, ambiguity handling, reconciliation, and audit records
remain authoritative. Manual test sends remain available only in development/test.
The production `line-service` also rejects every signed internal send that lacks the
matching positive `outboxId` and notification event key before replay or provider I/O.

### Durable Internal Request Replay

Run migration `033_create_internal_request_replays.sql` before starting this release. Every DB user that hosts a signed notification, LINE, or realtime intake needs only `SELECT, INSERT, DELETE` on `internal_request_replays`; do not grant `UPDATE`, DDL, or `GRANT OPTION` for replay handling. This includes the role-specific users for `web-api` or legacy notifier intake, `notification-service`, `line-service`, and `realtime-service` when those surfaces are enabled.

After applying those exact grants, run the capability preflight once with each enabled intake role's own DB credentials before starting that service. Dry-run validates only the mounted credential/TLS configuration; live mode uses a random synthetic fingerprint in one transaction, requires `SELECT, INSERT, DELETE`, verifies that `UPDATE` is denied, and always rolls back:

```bash
node scripts/internal-replay-grant-preflight.mjs --dry-run
node scripts/internal-replay-grant-preflight.mjs
```

The required result is exactly `{"ok":true,"mode":"dry-run","failureCodes":[]}` for dry-run and the same shape with `"mode":"live"` for the live check. Any non-empty `failureCodes` blocks startup. In particular, `excessive_privilege` means that role can `UPDATE` the replay table and its grants must be reduced before rollout. The script prints no DB host, user, credential path/value, SQL, raw fingerprint, or driver error.

The trusted deploy runs the live preflight automatically after migration and before
starting application services. It mounts the signed operator script over `/app/scripts`
in one-off containers so each checked role uses its exact Compose DB identity, CA, and
secret mounts. The current split rollout checks `web-api`, `notification-service`, and
`line-service`; a selected `realtime-service` is included
as well. OCR is DB-free and is never included. A malformed or non-empty result reaches
the existing deploy rollback trap without being echoed.

DB-backed boundaries atomically reserve a SHA-256 request fingerprint in shared MySQL, so the same signed request is rejected after a process or host restart while its timestamp window remains valid. The table does not store request bodies, signatures, or secrets. Database errors and capacity exhaustion fail closed using each endpoint's existing replay-unavailable status.

`ocr-service` remains DB-free. It writes mode-0600 fingerprint entries to `OCR_REPLAY_LEDGER_DIR=/app/data/internal-replay` on the existing private `ocr-auth` volume. Run one active `ocr-service` replica for that volume; do not use `docker compose --scale ocr-service=...`. Restarting or recreating the one replica preserves the ledger, while an unavailable, symlinked, malformed, or full ledger fails closed without invoking the OCR provider.

Before Task 9, rerun the same sanitized isolation gate inside every selected split container. Use project `spx-staging` on staging and `spx-production` only in the supervised production window. Every command must print `{"ok":true,"service":"<service>","failureCodes":[]}`; stop the drill on any other result:

```bash
for service in web-api notification-service line-service ocr-service worker-ptwl-split; do
  spx_production_compose --profile split \
    exec -T "$service" node scripts/container-isolation-probe.mjs --service="$service"
done
```

`SPX_NODE_ID` must be unique for every running service process and every worker machine. Keep `RUN_TEAM_IDS` explicit and non-overlapping. `SPX_NOTIFICATION_ALLOWED_NODE_TEAMS`, `SPX_LINE_SEND_ALLOWED_NODE_IDS`, `SPX_LINE_ADMIN_ALLOWED_NODE_IDS`, and the OCR node classifications are non-secret authorization maps in the Compose env file. Only notification-service receives `SPX_LINE_SERVICE_SEND_SECRET_NOTIFICATION_SERVICE_FILE`, and it must be the only current production entry in `SPX_LINE_SEND_ALLOWED_NODE_IDS`; line-service receives the matching inbound key ring through `SPX_LINE_SERVICE_SEND_NODE_SECRETS_FILE`. Web-api receives only the separate admin key in `SPX_LINE_SERVICE_ADMIN_SECRET_FILE`; workers receive no LINE credential.

Forward order is `primary`, then `team2`; rollback order is `team2`, then `primary`.
Each installer restores its verified prior container locally when its own activation
fails. For an operator-requested whole-release rollback, dispatch the previously
approved release artifact with its primary and TEAM 2 descriptors. Confirm the remote
worker is healthy and owns TEAM 2 before restoring the primary projection. Never start
`worker-ifn` or `worker-ifn-split` on the primary host. Confirm the primary `/ready`,
both exact image IDs, and fresh TEAM 1/TEAM 2 runtime leases before closing rollback.

### Phase 3 Poller/Auto-Accept Compose Profile

The `phase3` profile is a default-off, single-host confidence topology. It adds one `poller-service` and one `auto-accept-service` for each configured team. The processes use the same external MySQL host/schema but distinct DB users/password files, matching `RUN_TEAM_IDS` within each team pair, unique `SPX_NODE_ID` values, and private named spool volumes.

| Team | Poller | Auto-accept consumer | `RUN_TEAM_IDS` |
| ---- | ------ | -------------------- | -------------- |
| IFN | `poller-ifn-phase3` | `auto-accept-ifn-phase3` | `2` |
| PTWL | `poller-ptwl-phase3` | `auto-accept-ptwl-phase3` | `1` |

Set `SPX_PHASE3_NOTIFIER_API_URL` only when the target notification intake differs from `http://notification-service:3002/internal/notification-events`. Name every service explicitly; a bare profile startup can also select unrelated default services.

Cut over one team at a time in staging or a supervised production window:

1. Start the auto-accept consumer first, for example `docker compose --profile phase3 up -d --no-deps auto-accept-ifn-phase3`.
2. Confirm its runtime-node heartbeat is fresh and its enabled modes are exactly `autoAcceptReal` and `autoAcceptSettlement`.
3. Stop the legacy worker for that team, for example `docker compose stop worker-ifn-split` (or `worker-ifn` in the legacy topology).
4. Wait for the old team lease to release or expire; do not continue while the old worker still owns the team.
5. Run `npm run service:phase3-rollback-guard` and confirm zero live claims. For forward cutover, also confirm the durable consumer is healthy before starting a new producer.
6. Start the poller-service, for example `docker compose --profile phase3 up -d --no-deps poller-ifn-phase3`.
7. Run the read-only confidence check with the exact node/team pair and confirm fresh poller lease/metrics plus fresh auto-accept heartbeat:

```bash
npm run service:phase3-runtime-confidence -- \
  --poller-node-id=prod-poller-ifn-phase3-1 \
  --auto-accept-node-id=prod-auto-accept-ifn-phase3-1 \
  --team-ids=2 \
  --auto-accept-modes=autoAcceptReal,autoAcceptSettlement
```

Before rollback to an inline `worker` process:

1. Stop the Phase 3 poller so no new durable jobs are published.
2. Keep the auto-accept consumer running until live claims are zero and the queue is empty. If work cannot be drained, it must be explicitly quarantined as `dead_letter` or `cancelled`; unresolved `indeterminate` or unknown statuses block rollback.
3. Run `npm run service:phase3-rollback-guard`; a nonzero exit means inline execution must remain stopped.
4. Stop the Phase 3 auto-accept consumer only after the guard passes.
5. Restart exactly one legacy/compatibility worker for the team and verify its lease, web readiness, notification outbox, and absence of duplicate SPX attempts.

The dry-run forms validate CLI/bootstrap inputs without querying MySQL:

```bash
npm run service:phase3-runtime-confidence -- --dry-run \
  --poller-node-id=prod-poller-ifn-phase3-1 \
  --auto-accept-node-id=prod-auto-accept-ifn-phase3-1 \
  --team-ids=2 \
  --auto-accept-modes=autoAcceptReal,autoAcceptSettlement
npm run service:phase3-rollback-guard -- --dry-run
```

This profile is local configuration confidence only. It does not prove a live rollout. Phase 3 remains open until an approved staging or supervised-production exercise captures sanitized multi-host cutover and rollback evidence.

### Internal Realtime Service (Optional)

The `realtime` profile adds `realtime-service` on Docker port `3005` with no host-published port. Web, notification, LINE, OCR, workers, and Phase 3 processes do not use Compose `depends_on` health coupling to realtime; an outage must degrade only realtime/read requests while their own readiness and business loops continue.

Remote routing is opt-in. A selected client receives `REALTIME_SERVICE_URL` plus a mounted `REALTIME_SHARED_SECRET_FILE`. Set its `SPX_REALTIME_*_URL` input to `http://realtime-service:3005`; runtime normalizes it to `/internal/realtime`. LINE and OCR do not publish realtime events and receive no realtime credential.

| Client | Compose URL input | Host secret-file input |
| ------ | ----------------- | ---------------------- |
| `web-api` | `SPX_REALTIME_WEB_API_URL` | `SPX_REALTIME_SHARED_SECRET_WEB_API_FILE` |
| `notification-service` | `SPX_REALTIME_NOTIFICATION_SERVICE_URL` | `SPX_REALTIME_SHARED_SECRET_NOTIFICATION_SERVICE_FILE` |
| split workers | `SPX_REALTIME_WORKER_IFN_SPLIT_URL`, `SPX_REALTIME_WORKER_PTWL_SPLIT_URL` | matching `SPX_REALTIME_SHARED_SECRET_*_FILE` inputs |
| Phase 3 poller/consumer processes | service-specific `SPX_REALTIME_*_PHASE3_URL` inputs | matching `SPX_REALTIME_SHARED_SECRET_*_FILE` inputs |
| legacy notifier/workers | `SPX_REALTIME_NOTIFIER_URL`, `SPX_REALTIME_WORKER_IFN_URL`, `SPX_REALTIME_WORKER_PTWL_URL` | matching `SPX_REALTIME_SHARED_SECRET_*_FILE` inputs |

`x-spx-common` does not load `.env` and does not mount host data. Compose sees only non-secret interpolation values and secret-file paths. Each role mounts only its own secret sources at `/run/secrets`; use `docker compose config --quiet` for syntax validation because rendering the full model can disclose host paths and resolved environment values.

Provide per-node inbound authentication separately:

- `REALTIME_TRUSTED_NODE_IDS` lists every allowed producer/reader node.
- `REALTIME_ADMIN_NODE_IDS` explicitly lists trusted admin readers/producers. A trusted node must appear in exactly one classification: this admin list XOR `REALTIME_ALLOWED_NODE_TEAMS`.
- `REALTIME_ALLOWED_NODE_TEAMS` maps each team-scoped node to its allowed teams.
- `SPX_REALTIME_NODE_SECRETS_REALTIME_SERVICE_FILE` supplies the realtime-service inbound map. Separate notifier, web, and notification-service map files exist only for their rollback intake surfaces.
- Compact maps use `node-id=at-least-32-character-secret` entries separated by commas. JSON key rings may use `{ "active", "previous", "previousExpiresAt" }`; previous keys are accepted only until a bounded ISO expiry. Node IDs exactly match the trusted set and every active/previous secret is unique.
- Each intake map contains only the producer identities that surface accepts. A configured map is authoritative: an unmapped caller never falls back to a shared credential.
- Every producer has a distinct outbound key file. Reusing one cluster-wide key or sharing an inbound map with a producer is forbidden.
- Previous-key use emits a non-secret warning for rotation monitoring. Remove the previous key only after its bounded expiry and after monitoring shows no remaining previous-key traffic.

Legacy shared authentication is non-production compatibility only. Production mapped realtime intake rejects every unmapped team or admin identity.

Start exactly one service replica, then recreate only the clients that should use it:

```bash
docker compose --profile realtime up -d --no-deps realtime-service
docker compose --profile split up -d --no-deps --force-recreate \
  web-api notification-service \
  worker-ifn-split worker-ptwl-split
```

`docker-compose.yml` declares one replica, but the hard safety boundary is the MySQL advisory lock. Exactly one realtime-service replica may own persisted listeners/fan-out; a second process must fail startup/readiness when it cannot acquire that lock. Do not scale this service until the architecture replaces the singleton delivery boundary.

Realtime rollback preserves the migration and centralizes new events on web instead of creating one local store per producer:

1. Keep `SPX_REALTIME_WEB_API_URL` empty so web uses its local persistent read/SSE handlers.
2. Set every split producer-specific URL input to `http://web-api:3000`; retain each producer's per-node outbound key and load matching producer key rings through `SPX_REALTIME_NODE_SECRETS_WEB_API_FILE`. Keep `SPX_REALTIME_ALLOWED_NODE_TEAMS_WEB_API` aligned with those assignments.
3. Restart `web-api` first and verify `/ready`, then restart the producer processes. Do not stop the remote service until every recreated producer is posting to web successfully.
4. Verify authenticated web `/events`, `/metrics`, `/metrics/history`, and `/api/runtime/status`, plus new producer events and SSE cursor continuity on the web intake.
5. Stop `realtime-service` only after web is central and the restarted producers no longer call port `3005`.

For the legacy topology, use the same sequence with `SPX_REALTIME_NOTIFIER_URL` empty, producer URLs set to `http://notifier:3000`, and retained key rings loaded through `SPX_REALTIME_NODE_SECRETS_NOTIFIER_FILE`.

Local Compose checks do not close the rollout gate. Before enabling remote routing in production, capture staging or supervised-production evidence for advisory-lock contention, MySQL outage/recovery, realtime restart and SSE cursor resume, reverse-proxy buffering/TLS behavior, cached read degradation, and web/worker independence. This runbook does not claim a live rollout.

### Worker-Only Runtime Rollout

Use this path when the web API, notification-service, line-service, and ocr-service are already running the target compatible build and an operator needs to replace or move one team worker without recreating the public web/API surface.

Preconditions:

- The target worker image or source checkout already matches the version expected by the running HTTP services.
- The worker has a unique `SPX_NODE_ID`.
- `RUN_TEAM_IDS` is explicit and does not overlap another active worker unless this is a supervised failover drill.
- The worker can reach the shared MySQL database and the configured notifier or notification-service URL.
- `docker compose ps` shows the web/API and notification services healthy before touching the worker.

Legacy topology worker restart:

```bash
docker compose up -d --no-deps --force-recreate worker-ifn
docker compose up -d --no-deps --force-recreate worker-ptwl
```

Split topology worker restart:

```bash
docker compose --profile split up -d --no-deps --force-recreate worker-ifn-split
docker compose --profile split up -d --no-deps --force-recreate worker-ptwl-split
```

Move one team to a replacement worker by stopping the old worker, starting the replacement with the same `RUN_TEAM_IDS` and a different `SPX_NODE_ID`, then waiting for the old lease to expire or releasing it through the normal runtime control path. Do not run both workers with the same team assignment as a steady state.

Worker-only verification:

```bash
docker compose ps
docker compose logs --since=5m worker-ifn worker-ptwl | grep -c 'runtime-metrics-publish-failed\|runtime-metrics-url-invalid'
```

Capture the authenticated admin runtime lease observation with the safe smoke command. Keep the cookie only in the current PowerShell process; the command accepts it only through `SERVICE_WORKER_RUNTIME_AUTH_COOKIE` and writes only sanitized evidence to `runtime-status-after.json`.

```powershell
$runtimeStatusUrl = Read-Host "Runtime status URL ending in /api/runtime/status"
$expectedTeamIds = Read-Host "Expected team IDs (comma-separated)"
$expectedOwnerNodeId = Read-Host "Expected replacement worker node ID"
$env:SERVICE_WORKER_RUNTIME_AUTH_COOKIE = Read-Host -MaskInput "Admin session cookie"
try {
  npm run --silent service:worker-runtime-status-check -- `
    "--url=$runtimeStatusUrl" `
    "--expected-team-ids=$expectedTeamIds" `
    "--expected-owner-node-id=$expectedOwnerNodeId" `
    "--timeout-ms=5000" > runtime-status-after.json
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath runtime-status-after.json -ErrorAction SilentlyContinue
    throw "Worker runtime status smoke check failed"
  }
} finally {
  Remove-Item Env:SERVICE_WORKER_RUNTIME_AUTH_COOKIE -ErrorAction SilentlyContinue
}
```

For split topology, check split workers and notification-service logs:

```bash
docker compose --profile split ps worker-ifn-split worker-ptwl-split
docker compose --profile split logs --since=5m notification-service | grep -c 'POST /internal/runtime-metrics 200'
docker compose --profile split logs --since=5m worker-ifn-split worker-ptwl-split | grep -c 'runtime-metrics-publish-failed\|runtime-metrics-url-invalid'
```

Expected result: `runtime-status-after.json` and the Teams dashboard show the replacement worker's `ownerNodeId`, `ownerRole`, heartbeat, and lease expiry for its assigned teams; worker metric publish failures stay at zero; public `/ready` remains healthy throughout the worker replacement.

After collecting sanitized worker-only drill evidence, validate the bundle locally:

```bash
node scripts/service-worker-evidence-check.mjs --help
node scripts/service-worker-evidence-check.mjs --template > worker-only-evidence.json
node scripts/service-worker-evidence-check.mjs --file=worker-only-evidence.json
```

For an evidence folder instead of one JSON file:

```bash
node scripts/service-worker-evidence-check.mjs --dir-manifest
node scripts/service-worker-evidence-check.mjs --init-dir=worker-only-evidence
node scripts/service-worker-evidence-check.mjs --dir-status=worker-only-evidence
node scripts/service-worker-evidence-check.mjs --dir=worker-only-evidence
```

The checker is non-mutating after the optional scaffold step. It verifies concrete `staging` or `supervised-production` metadata, timestamp order, public web/API readiness before and after replacement, exactly one active lease per expected team owned by the replacement worker, and zero worker runtime-metrics publish failures. `--dir-status` reports only missing, placeholder, invalid, and semantic check names so operators can see the next required file without printing evidence values. The checker prints only pass/fail metadata and rejects raw logs, payloads, targets, and secret-shaped fields.

### Ambiguous LINE Delivery Reconciliation

`provider_sending` and `delivery_ambiguous` rows are deliberately never reclaimed automatically. An admin must first verify the outcome in the LINE provider console or another authoritative provider record. The authenticated endpoint returns only reconciliation metadata; it never returns notification targets, messages, or payloads:

```bash
curl --fail --silent --show-error \
  --cookie 'token=<signed-admin-cookie>' \
  https://<web-api-host>/api/notification-reconciliation
```

Record the exact `outboxId`, `status`, `providerRequestId`, and `providerStartedAt` from that fresh response. If provider evidence proves delivery, submit an optimistic `mark_sent` command:

```bash
curl --fail --silent --show-error \
  --cookie 'token=<signed-admin-cookie>' \
  --header 'content-type: application/json' \
  --request POST \
  --data '{"action":"mark_sent","expectedStatus":"delivery_ambiguous","providerRequestId":"<exact-request-id>","expectedProviderStartedAt":"<YYYY-MM-DD HH:MM:SS from GET>","confirmation":"PROVIDER_CONFIRMED_SENT","evidenceReference":"<provider-record-or-ticket>","reason":"<bounded operator reason>","providerMessageId":"<optional-provider-id>"}' \
  https://<web-api-host>/api/notification-reconciliation/<outbox-id>
```

Use `requeue_not_sent` only when authoritative evidence proves the provider did not accept or deliver the message. This is not a timeout-recovery shortcut. For a `provider_sending` row, first stop or drain the LINE service node named by `lockedBy`, then wait until both its provider fence and runtime heartbeat are older than 120 seconds. A missing node record, a fresh heartbeat, or a restarted node fails closed with `409`:

```bash
curl --fail --silent --show-error \
  --cookie 'token=<signed-admin-cookie>' \
  --header 'content-type: application/json' \
  --request POST \
  --data '{"action":"requeue_not_sent","expectedStatus":"provider_sending","providerRequestId":"<exact-request-id>","expectedProviderStartedAt":"<YYYY-MM-DD HH:MM:SS from GET>","confirmation":"PROVIDER_CONFIRMED_NOT_SENT","evidenceReference":"<provider-record-or-ticket>","reason":"<bounded operator reason>"}' \
  https://<web-api-host>/api/notification-reconciliation/<outbox-id>
```

The status, provider request id, and provider-start timestamp are optimistic locks. A stale or conflicting command returns `409` and performs no mutation. An identical retry returns the existing result without adding another audit or delivery record, while that result remains current. The outbox change, reconciliation delivery record, and `Reconcile Notification Delivery` audit row commit in one DB transaction; DB or audit failure returns `503` and rolls the change back.

### Split-Service Fault-Injection Drill

The service fault drill is staging-only. Its fixed rollout controller consumes
each pre-approved signed LINE/OCR action through the durable action journal;
operators do not mutate LINE/OCR through raw Compose. Production Task 9 uses
signed safe-target boundary permits through the Gate 6 controller and never
stops a production dependency.

#### Staging-only raw service fault drill

Start one dedicated operator shell on the A3 staging application host and bind
every drill command to the installed immutable staging release. This path has
no production target and must never run on the production application host:

```bash
TASK9_ENVIRONMENT=staging
readonly TASK9_ENVIRONMENT
: "${TASK9_DRILL_ID:?set one unique Task 9 drill id}"
: "${TASK9_TEAM_ID:?set the approved drill team id}"
: "${TASK9_WORKER_SERVICE:?set worker-ifn-split or worker-ptwl-split}"
printf '%s\n' "$TASK9_DRILL_ID" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
printf '%s\n' "$TASK9_DRILL_ID" | grep -Eviq 'placeholder|yyyy|example|change-me|todo'
printf '%s\n' "$TASK9_TEAM_ID" | grep -Eq '^[1-9][0-9]*$'
case "$TASK9_WORKER_SERVICE" in
  worker-ifn-split|worker-ptwl-split) ;;
  *) printf '%s\n' 'unsupported Task 9 worker service' >&2; return 1 2>/dev/null || exit 1 ;;
esac
TASK9_ACTIVE_PROJECTION=/opt/spx-staging/release/current
TASK9_RELEASE_PATTERN='^/opt/spx-staging/release/[0-9a-f]{40}/operator$'
TASK9_COMPOSE_PROJECT=spx-staging
TASK9_ENV_FILE=/etc/spx-staging/runtime.env
TASK9_RELEASE_BINDING=/var/lib/spx-staging-rollout/verified-release-binding.json
TASK9_EVIDENCE_ROOT=/var/lib/spx-staging-rollout/task9-evidence
test -L "$TASK9_ACTIVE_PROJECTION"
TASK9_ACTIVE_RELEASE="$(readlink -f "$TASK9_ACTIVE_PROJECTION")"
printf '%s\n' "$TASK9_ACTIVE_RELEASE" | grep -Eq "$TASK9_RELEASE_PATTERN"
TASK9_RELEASE_PARENT="$(dirname "$TASK9_ACTIVE_RELEASE")"
test "$(stat -c %u "$TASK9_ACTIVE_RELEASE")" = 0
test -z "$(find "$TASK9_ACTIVE_RELEASE" -maxdepth 0 -perm /022 -print)"
test -f "$TASK9_RELEASE_PARENT/deployment-context.json"
test -f "$TASK9_RELEASE_PARENT/release-manifest.json"
TASK9_IMAGE="$(node -e '
  const context = require(process.argv[1]);
  if (!/^spx-app:[0-9a-f]{40}$/.test(context.imageTag ?? "")) process.exit(1);
  process.stdout.write(context.imageTag);
' "$TASK9_RELEASE_PARENT/deployment-context.json")"
TASK9_RELEASE_MANIFEST="$TASK9_RELEASE_PARENT/release-manifest.json"
TASK9_EXPECTED_IMAGE_ID="$(node -e '
  const context = require(process.argv[1]);
  if (!/^sha256:[0-9a-f]{64}$/.test(context.imageId ?? "")) process.exit(1);
  process.stdout.write(context.imageId);
' "$TASK9_RELEASE_PARENT/deployment-context.json")"
TASK9_EXPECTED_MANIFEST_SHA256="$(node -e '
  const context = require(process.argv[1]);
  if (!/^[0-9a-f]{64}$/.test(context.releaseManifestSha256 ?? "")) process.exit(1);
  process.stdout.write(context.releaseManifestSha256);
' "$TASK9_RELEASE_PARENT/deployment-context.json")"
test "$(docker image inspect --format '{{.Id}}' "$TASK9_IMAGE")" = "$TASK9_EXPECTED_IMAGE_ID"
test "$(sha256sum "$TASK9_RELEASE_MANIFEST" | awk '{print $1}')" = "$TASK9_EXPECTED_MANIFEST_SHA256"
test -r "$TASK9_RELEASE_BINDING"
task9_compose() {
  test "$(docker image inspect --format '{{.Id}}' "$TASK9_IMAGE")" = "$TASK9_EXPECTED_IMAGE_ID" || return 1
  test "$(sha256sum "$TASK9_RELEASE_MANIFEST" | awk '{print $1}')" = "$TASK9_EXPECTED_MANIFEST_SHA256" || return 1
  SPX_IMAGE="$TASK9_IMAGE" \
    SPX_RELEASE_MANIFEST_PATH="$TASK9_RELEASE_MANIFEST" \
    SPX_TARGET_DESCRIPTOR_PATH="$TASK9_RELEASE_PARENT/deployment-target-descriptor.json" \
    SPX_DEPLOYMENT_CONTEXT_PATH="$TASK9_RELEASE_PARENT/deployment-context.json" \
    docker compose -p "$TASK9_COMPOSE_PROJECT" \
      --project-directory "$TASK9_ACTIVE_PROJECTION" \
      --env-file "$TASK9_ENV_FILE" \
      -f "$TASK9_ACTIVE_PROJECTION/docker-compose.yml" \
      --profile split "$@"
}
task9_compose config --services | grep -Fx web-api
task9_compose config --services | grep -Fx notification-service
task9_compose config --services | grep -Fx line-service
task9_compose config --services | grep -Fx ocr-service
TASK9_EVIDENCE_DIR="$TASK9_EVIDENCE_ROOT/$TASK9_DRILL_ID"
install -d -m 0700 "$TASK9_EVIDENCE_ROOT"
if [ ! -e "$TASK9_EVIDENCE_DIR" ]; then
  node "$TASK9_ACTIVE_PROJECTION/scripts/service-fault-evidence-check.mjs" \
    --environment="$TASK9_ENVIRONMENT" --init-dir="$TASK9_EVIDENCE_DIR"
else
  test -d "$TASK9_EVIDENCE_DIR"
  node "$TASK9_ACTIVE_PROJECTION/scripts/service-fault-evidence-check.mjs" \
    --environment="$TASK9_ENVIRONMENT" --dir-status="$TASK9_EVIDENCE_DIR"
fi
```

Keep this shell open for the full drill. A missing symlink, mutable path, release context, release manifest, or verified binding is a hard stop. The `task9_compose` function always passes the explicit project, project directory, environment file, Compose file, image, manifest, and split profile; bare `docker compose` commands are forbidden during Task 9.

Read-only host probe for the public web API:

```bash
(cd "$TASK9_ACTIVE_PROJECTION" && node scripts/service-fault-check.mjs --help)
(cd "$TASK9_ACTIVE_PROJECTION" && node scripts/service-fault-check.mjs --web-api-url=http://127.0.0.1:3000)
```

Read-only internal probe from inside the Docker network:

```bash
task9_compose exec -T web-api sh -lc '
  node scripts/service-fault-check.mjs --help
'
```

```bash
task9_compose exec -T web-api sh -lc '
  WEB_API_URL=http://web-api:3000 \
  NOTIFICATION_SERVICE_URL=http://notification-service:3002 \
  LINE_SERVICE_URL=http://line-service:3003 \
  OCR_SERVICE_URL=http://ocr-service:3004 \
  node scripts/service-fault-check.mjs --require=web-api,notification-service,line-service,ocr-service
'
```

`--help` prints the read-only probe options without calling `/health` or `/ready`. Use the internal probe for `notification-service`, `line-service`, and `ocr-service` because they are intentionally not published to the host. The `--require` list prevents a false-positive drill if one of the internal service URLs is missing from the probe environment. Keep the JSON output from each probe as drill evidence; it records `requiredServices`, `allowedDownServices`, `allowedDegradedServices`, `expectedDownServices`, `unknownServiceNames`, `missingRequiredServices`, `missingExpectedDownServices`, `expectedDownStillReachableServices`, `unexpectedFailures`, and sanitized service URLs/status payloads. `--allow-degraded=<service>` means that service must still pass `/health` and must fail `/ready` because an expected downstream dependency is unavailable. Avoid full `docker compose config` output during the drill; it can expand env-file values. Use `task9_compose config --services` only when service-name validation is needed.

For expected-down evidence, the probe options must match the runbook exactly: `allowedDownServices` must be empty, `expectedDownServices` must contain only the stopped service, and `allowedDegradedServices` must contain only the explicitly allowed downstream service for that step. `missingRequiredServices` must also be empty. The stopped service row must be present and down, allowed degraded service rows must be present and degraded, and every other required service row must be present and healthy.

Manual drill:

1. Start `web-api`, `notification-service`, `line-service`, `ocr-service`, and one split worker.
2. Confirm web API `/health` and `/ready` return success.
3. Confirm notification-service `/ready` is healthy when line-service is reachable.
4. Publish one controlled staging notification event and record its `eventKey`. This creates a real `notification_outbox` row and may send one LINE notification when the dispatcher is running, so use a staging team id or a supervised production drill target:

   Preflight the exact routing config first without sending the notification:

   ```bash
   task9_compose exec -T "$TASK9_WORKER_SERVICE" sh -lc '
     node scripts/service-fault-publish-notification.mjs --help
   '
   ```

   ```bash
   task9_compose exec -T \
     -e TASK9_TEAM_ID="$TASK9_TEAM_ID" \
     -e TASK9_DRILL_ID="$TASK9_DRILL_ID" \
     "$TASK9_WORKER_SERVICE" sh -lc '
     node scripts/service-fault-publish-notification.mjs \
       --url=http://notification-service:3002/internal/notification-events \
       --team-id="$TASK9_TEAM_ID" \
       --drill-id="$TASK9_DRILL_ID" \
       --step=baseline \
       --dry-run
   '
   ```

   ```bash
   task9_compose exec -T \
     -e TASK9_TEAM_ID="$TASK9_TEAM_ID" \
     -e TASK9_DRILL_ID="$TASK9_DRILL_ID" \
     "$TASK9_WORKER_SERVICE" sh -lc '
     node scripts/service-fault-publish-notification.mjs \
       --url=http://notification-service:3002/internal/notification-events \
       --team-id="$TASK9_TEAM_ID" \
       --drill-id="$TASK9_DRILL_ID" \
       --step=baseline \
       --confirm-send-test-notification
   '
   ```

   `$TASK9_WORKER_SERVICE` is validated by the preamble and must be the one worker already approved for `$TASK9_TEAM_ID`; never run the publisher in `notification-service` and never mount a worker key into that receiver. `--help` prints the publisher safety contract without reading drill config or sending a request. The dry run validates required config, endpoint normalization, team id, process node id, concrete drill id, and step without creating a request, outbox row, or LINE notification. Drill ids are limited to 128 characters. The real publisher signs HMAC v2 with that worker's process-local `NOTIFICATION_NODE_SECRET` and a fresh transport request id; production never reads a shared key from MySQL. `--step=baseline` deterministically binds the business idempotency key to the drill, team, and baseline step. Re-running the exact same step is safe: a duplicate response with the existing positive `outboxId` and non-empty `outboxStatus` is reported as `idempotentRecovery: true` instead of creating a replacement event. The output contains only safe evidence such as `drillId`, `step`, `eventKey`, HTTP status, duplicate status, outbox id, and outbox status. An optional `--node-id` is only an equality assertion against `SPX_NODE_ID` and cannot override the signed identity.

5. Confirm the event is visible in aggregate outbox evidence without printing targets or message bodies:

   ```bash
   task9_compose exec -T notification-service sh -lc '
     node scripts/service-fault-outbox-check.mjs --help
   '
   ```

   ```bash
   task9_compose exec -T notification-service sh -lc '
     EVENT_KEY="<eventKey from previous step>" \
     node scripts/service-fault-outbox-check.mjs --dry-run --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --max-pending=0 --delivery-phase=baseline
   '
   ```

   ```bash
   task9_compose exec -T notification-service sh -lc '
     EVENT_KEY="<eventKey from previous step>" \
     node scripts/service-fault-outbox-check.mjs --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --max-pending=0 --delivery-phase=baseline
   '
   ```

   `--help` prints the read-only outbox evidence contract without reading DB env or querying MySQL. `service-fault-outbox-check.mjs` accepts exactly one database credential source, `DB_PASSWORD` or `DB_PASSWORD_FILE`; mounted-file paths and values are never emitted. The outbox dry run validates DB env presence, the 30-minute window, expectation flags, and event-key hash binding without querying MySQL; it refuses dry-run/live checks that omit `--event-key-contains`, and it is not final evidence because final evidence must use `mode: "mysql"`. The real outbox checker does not echo the raw event key filter. It performs an exact `event_key` lookup, emits `filters.eventKeyContainsSha256`, and the evidence checker compares that hash with the publisher `eventKey` so the outbox proof is tied to the same drill event. Keep the outbox command flags exactly as shown; all outbox evidence must use `--since-minutes=30`, baseline sent evidence must include `--min-total=1 --expect-sent --max-pending=0`, and recovery sent evidence must include `--min-total=1 --expect-sent --expect-failed-attempt --max-pending=0`. If dispatch is still pending, wait a bounded interval and re-run the same read-only outbox command instead of republishing the notification.

6. Stop line-service through the signed rollout controller: `npm run --silent service:a3-staging-rollout-controller -- line-fault`.
7. Confirm web API still returns success: `curl -s http://127.0.0.1:3000/health`.
8. Probe from inside the Docker network with intentional LINE outage allowed:

   ```bash
   task9_compose exec -T web-api sh -lc '
     WEB_API_URL=http://web-api:3000 \
     NOTIFICATION_SERVICE_URL=http://notification-service:3002 \
     LINE_SERVICE_URL=http://line-service:3003 \
     OCR_SERVICE_URL=http://ocr-service:3004 \
     node scripts/service-fault-check.mjs --require=web-api,notification-service,line-service,ocr-service --expect-down=line-service --allow-degraded=notification-service
   '
   ```

9. Publish another controlled notification event while line-service is stopped, then confirm notification outbox failures are retryable rather than process crashes:

   ```bash
   task9_compose exec -T "$TASK9_WORKER_SERVICE" sh -lc '
     node scripts/service-fault-publish-notification.mjs --help
   '
   ```

   ```bash
   task9_compose exec -T \
     -e TASK9_TEAM_ID="$TASK9_TEAM_ID" \
     -e TASK9_DRILL_ID="$TASK9_DRILL_ID" \
     "$TASK9_WORKER_SERVICE" sh -lc '
     node scripts/service-fault-publish-notification.mjs \
       --url=http://notification-service:3002/internal/notification-events \
       --team-id="$TASK9_TEAM_ID" \
       --drill-id="$TASK9_DRILL_ID" \
       --step=line-down \
       --dry-run
   '
   ```

   ```bash
   task9_compose exec -T \
     -e TASK9_TEAM_ID="$TASK9_TEAM_ID" \
     -e TASK9_DRILL_ID="$TASK9_DRILL_ID" \
     "$TASK9_WORKER_SERVICE" sh -lc '
     node scripts/service-fault-publish-notification.mjs \
       --url=http://notification-service:3002/internal/notification-events \
       --team-id="$TASK9_TEAM_ID" \
       --drill-id="$TASK9_DRILL_ID" \
       --step=line-down \
       --confirm-send-test-notification
   '
   ```

   Use the same preflight-bound worker service, team id, and drill id as the baseline step. The required `--step=line-down` produces a second deterministic business key while a safe rerun of this same outage step resolves to the existing outbox row.

   ```bash
   task9_compose exec -T notification-service sh -lc '
     EVENT_KEY="<eventKey from outage publish step>" \
     node scripts/service-fault-outbox-check.mjs --dry-run --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-failed-attempt --delivery-phase=line-down
   '
   ```

   ```bash
   task9_compose exec -T notification-service sh -lc '
     EVENT_KEY="<eventKey from outage publish step>" \
     node scripts/service-fault-outbox-check.mjs --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-failed-attempt --delivery-phase=line-down
   '
   ```

10. Confirm the split worker remains alive with `task9_compose ps worker-ifn-split worker-ptwl-split`; only the intentionally stopped service should be exited, and `notification-service` may report unhealthy while `/ready` is degraded by the expected downstream LINE outage.
11. Restart line-service through the signed rollout controller: `npm run --silent service:a3-staging-rollout-controller -- line-recover`. A transport failure can leave the outage row in `delivery_ambiguous`; this is unresolved delivery, not permission to resend. Before the recovery capture, inspect the authenticated reconciliation endpoint above using the exact outbox/request/start fence. Only after an authoritative provider record proves the controlled outage notification was not sent may an admin apply `requeue_not_sent` with its evidence reference and confirmation. If non-delivery cannot be established, stop the drill and retain the ambiguous row. Never automatically reconcile from a timeout or from this runbook alone. After that audited action, confirm the same outbox row drains after recovery:

    ```bash
    task9_compose exec -T notification-service sh -lc '
      EVENT_KEY="<eventKey from outage publish step>" \
      node scripts/service-fault-outbox-check.mjs --dry-run --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --expect-failed-attempt --max-pending=0 --delivery-phase=recovery
    '
    ```

    ```bash
    task9_compose exec -T notification-service sh -lc '
      EVENT_KEY="<eventKey from outage publish step>" \
      node scripts/service-fault-outbox-check.mjs --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --expect-failed-attempt --max-pending=0 --delivery-phase=recovery
    '
    ```

    Recovery can be delayed by retry backoff. If the first read-only recovery check still shows a pending retryable row, wait a bounded interval and re-run the same command; do not publish a replacement event for recovery evidence.

12. Preflight the fixed synthetic OCR request from inside the running line-service container while ocr-service is healthy. The help and dry-run modes do not resolve the shared secret, query MySQL, call the OCR provider, or probe line-service:

    ```bash
    task9_compose exec -T line-service sh -lc '
      node scripts/service-fault-ocr-boundary-probe.mjs --help
    '
    ```

    ```bash
    task9_compose exec -T -e TASK9_DRILL_ID="$TASK9_DRILL_ID" line-service sh -lc '
      TASK9_EXPECT=preflight \
      TASK9_CONFIRM_SYNTHETIC_OCR=I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER \
      node scripts/service-fault-ocr-boundary-probe.mjs --dry-run
    '
    ```

    ```bash
    task9_compose exec -T -e TASK9_DRILL_ID="$TASK9_DRILL_ID" line-service sh -lc '
      TASK9_EXPECT=preflight \
      TASK9_CONFIRM_SYNTHETIC_OCR=I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER \
      node scripts/service-fault-ocr-boundary-probe.mjs
    '
    ```

    Keep the sanitized live output as `ocr-preflight.json`. It is bound to the concrete drill id, line-service node id, internal `http://ocr-service:3004/internal/ocr/line-image` route, and checked-in fixture SHA-256 `cdf7dcb00ca85d93e950cba10ac707c6e27c1dca828673512831454fbd53f73c`. The live command calls the configured OCR provider with that synthetic fixture and therefore requires the exact confirmation value shown. `OCR_SERVICE_REQUEST_TIMEOUT_MS` defaults to `305000` milliseconds for this probe and must not exceed the enforced `600000` millisecond maximum. Drill and node ids must be 1-128 characters, start with a letter or number, contain only letters, numbers, dots, underscores, or hyphens, and must not contain placeholder markers. The probe writes a mode-0600 preflight state under `/tmp` in the line-service container; complete the outage and recovery probes in the same container within 30 minutes.

13. Stop ocr-service through the signed rollout controller: `npm run --silent service:a3-staging-rollout-controller -- ocr-fault`.
14. Probe from inside the Docker network with expected OCR outage, and keep the output as `ocr-down-probe.json`:

    ```bash
    task9_compose exec -T web-api sh -lc '
      WEB_API_URL=http://web-api:3000 \
      NOTIFICATION_SERVICE_URL=http://notification-service:3002 \
      LINE_SERVICE_URL=http://line-service:3003 \
      OCR_SERVICE_URL=http://ocr-service:3004 \
      node scripts/service-fault-check.mjs --require=web-api,notification-service,line-service,ocr-service --expect-down=ocr-service
    '
    ```

15. Prove the same signed synthetic request fails retryably while line-service remains healthy and ready with its OCR dependency down. Run the dry-run first, then keep the sanitized live output as `ocr-failure-observed.json`:

    ```bash
    task9_compose exec -T -e TASK9_DRILL_ID="$TASK9_DRILL_ID" line-service sh -lc '
      TASK9_EXPECT=down \
      TASK9_CONFIRM_SYNTHETIC_OCR=I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER \
      node scripts/service-fault-ocr-boundary-probe.mjs --dry-run
    '
    ```

    ```bash
    task9_compose exec -T -e TASK9_DRILL_ID="$TASK9_DRILL_ID" line-service sh -lc '
      TASK9_EXPECT=down \
      TASK9_CONFIRM_SYNTHETIC_OCR=I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER \
      node scripts/service-fault-ocr-boundary-probe.mjs
    '
    ```

16. While ocr-service is still stopped, confirm the selected split worker remains alive with `task9_compose ps "$TASK9_WORKER_SERVICE"`. Record a minimal timestamped `worker-alive-ocr.json` with `evidenceType: "worker-alive-ocr"`; do not reuse the earlier LINE-outage worker observation.

17. From that same selected worker, publish the deterministic OCR-outage notification. Run the dry run first, then keep the sanitized live output as `ocr-down-publish.json`:

    ```bash
    task9_compose exec -T \
      -e TASK9_TEAM_ID="$TASK9_TEAM_ID" \
      -e TASK9_DRILL_ID="$TASK9_DRILL_ID" \
      "$TASK9_WORKER_SERVICE" sh -lc '
      node scripts/service-fault-publish-notification.mjs \
        --url=http://notification-service:3002/internal/notification-events \
        --team-id="$TASK9_TEAM_ID" \
        --drill-id="$TASK9_DRILL_ID" \
        --step=ocr-down \
        --dry-run
    '
    ```

    ```bash
    task9_compose exec -T \
      -e TASK9_TEAM_ID="$TASK9_TEAM_ID" \
      -e TASK9_DRILL_ID="$TASK9_DRILL_ID" \
      "$TASK9_WORKER_SERVICE" sh -lc '
      node scripts/service-fault-publish-notification.mjs \
        --url=http://notification-service:3002/internal/notification-events \
        --team-id="$TASK9_TEAM_ID" \
        --drill-id="$TASK9_DRILL_ID" \
        --step=ocr-down \
        --confirm-send-test-notification
    '
    ```

    Use the same team id, drill id, and worker service as the baseline and LINE-outage publishes. The exact `--step=ocr-down` event key is deterministic; rerunning it must recover the same positive outbox id with `duplicate: true` and `idempotentRecovery: true`, never create a replacement event.

18. Before restarting ocr-service, prove this OCR-outage notification was sent and left no pending outbox row. Keep the live output as `ocr-down-outbox.json`:

    ```bash
    task9_compose exec -T notification-service sh -lc '
      EVENT_KEY="<eventKey from OCR-outage publish step>" \
      node scripts/service-fault-outbox-check.mjs --dry-run --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --max-pending=0 --delivery-phase=baseline
    '
    ```

    ```bash
    task9_compose exec -T notification-service sh -lc '
      EVENT_KEY="<eventKey from OCR-outage publish step>" \
      node scripts/service-fault-outbox-check.mjs --since-minutes=30 --event-key-contains="$EVENT_KEY" --min-total=1 --expect-sent --max-pending=0 --delivery-phase=baseline
    '
    ```

19. Restart ocr-service through the signed rollout controller with `npm run --silent service:a3-staging-rollout-controller -- ocr-recover`, wait for its readiness check to pass, then prove the same request succeeds again. Run the dry-run first, then keep the sanitized live output as `ocr-recovery-observed.json`:

    ```bash
    task9_compose exec -T -e TASK9_DRILL_ID="$TASK9_DRILL_ID" line-service sh -lc '
      TASK9_EXPECT=up \
      TASK9_CONFIRM_SYNTHETIC_OCR=I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER \
      node scripts/service-fault-ocr-boundary-probe.mjs --dry-run
    '
    ```

    ```bash
    task9_compose exec -T -e TASK9_DRILL_ID="$TASK9_DRILL_ID" line-service sh -lc '
      TASK9_EXPECT=up \
      TASK9_CONFIRM_SYNTHETIC_OCR=I_UNDERSTAND_THIS_CALLS_THE_CONFIGURED_OCR_PROVIDER \
      node scripts/service-fault-ocr-boundary-probe.mjs
    '
    ```

Expected result: web API remains available while line-service or ocr-service is stopped; workers keep polling or remain independently healthy; the OCR-outage notification reaches LINE with no pending outbox row; notification/OCR failures are recorded or replied as degraded behavior rather than process-wide crashes.

The verified, release-bound evidence directory initialized by the preamble is mandatory. Put each full sanitized JSON output into the matching file's `payload` property while preserving its generated `releaseBinding` property byte-for-byte. Keep each script output's `checkedAt` value; the evidence checker verifies drill order from these timestamps and fails if the baseline, outage, recovery, and OCR probes are out of sequence or future-dated beyond a small clock-skew allowance. Do not paste raw logs, request payloads, response bodies, stdout/stderr captures, LINE targets, tokens, or secrets into evidence files; the checker rejects common unsafe fields and secret-like key variants such as `raw`, `payload`, `targetId`, `lineTargetId`, `stdout`, `stderr`, `accessToken`, `authorizationHeader`, and `sharedSecretValue`.

Set top-level rollout metadata before pasting step evidence: `drillId` must be a concrete unique id such as `split-service-fault-drill-20260707-1000`, not the scaffold placeholder `split-service-fault-drill-YYYYMMDD-HHMM`, and `environment` must be `staging`. Use the same concrete `drillId` in every `service-fault-publish-notification.mjs --drill-id=...` command. Local Docker drills remain useful confidence checks, but the final evidence checker intentionally rejects placeholder drill ids and `environment: "local"` so local-only or scaffold evidence cannot be mistaken for rollout evidence.

For `baselineProbe`, use the initial `--require=...` command without `--allow-down`, `--allow-degraded`, or `--expect-down`. For `lineDownProbe` and `ocrDownProbe`, keep the full sanitized `services` list including each row's internal Docker URL: `http://web-api:3000/`, `http://notification-service:3002/`, `http://line-service:3003/`, and `http://ocr-service:3004/`. The evidence checker rejects probes when option arrays differ from the runbook command, when `missingRequiredServices` is non-empty, when the expected-down service row is absent, when any service that should remain healthy is missing from the service rows, or when a service row points at a host/port outside the split-service Docker network.

For outbox evidence, keep the command flags exactly as shown. `baselineOutbox`, `lineDownOutbox`, `lineRecoveryOutbox`, and `ocrDownOutbox` must all include `sinceMinutes: 30` from the runbook `--since-minutes=30` lookup window and must be bound to the matching publisher output with `--event-key-contains=<eventKey>`, which performs an exact `event_key` lookup while hashing the filter in the output. `baselineOutbox` and `ocrDownOutbox` must each prove `--min-total=1 --expect-sent --max-pending=0` with no retried rows. `lineDownOutbox` must prove `--min-total=1 --expect-failed-attempt` and still show at least one unresolved row before line-service is restarted (including `delivery_ambiguous`, which requires the audited reconciliation in step11 before retry). `lineRecoveryOutbox` must prove `--min-total=1 --expect-sent --expect-failed-attempt --max-pending=0` so recovery evidence is tied to the same previously failed outage notification after it drains. All outbox evidence must have `mode: "mysql"` plus empty `missingDbEnv` and `expectationFailures` arrays; fixture-mode outbox output is useful for script tests only and is rejected by the final evidence checker.

For publish evidence, keep the full sanitized publisher output. `baselinePublish`, `lineDownPublish`, and `ocrDownPublish` must show `url: "http://notification-service:3002/internal/notification-events"`, the same positive `teamId`, the same non-empty `nodeId`, and three distinct deterministic event keys for `...:step:baseline`, `...:step:line-down`, and `...:step:ocr-down`. Each output also needs a positive `outboxId` and non-empty `outboxStatus`. A first acceptance records `duplicate: false` and `idempotentRecovery: false`; a safe rerun is accepted only when it records `duplicate: true` and `idempotentRecovery: true` for that same deterministic key. Scaffold keys, cross-team output, mismatched drill/step keys, or legacy notifier/web-api publish output is rejected.

- `baselineProbe`: initial `service-fault-check.mjs --require=...`
- `workerBaseline`: set `{ "ok": true, "checkedAt": "<ISO timestamp>", "evidenceType": "worker-running", "note": "..." }` after `task9_compose ps` or logs prove one split worker is running before the baseline publish
- `baselinePublish`: first `service-fault-publish-notification.mjs`
- `baselineOutbox`: first `service-fault-outbox-check.mjs`
- `lineDownProbe`: `service-fault-check.mjs --expect-down=line-service --allow-degraded=notification-service`
- `lineDownPublish`: outage publish command
- `lineDownOutbox`: outage outbox check
- `workerAlive`: set `{ "ok": true, "checkedAt": "<ISO timestamp>", "evidenceType": "worker-alive", "note": "..." }` after `task9_compose ps` or logs prove worker stayed alive
- `lineRecoveryOutbox`: post-restart outbox check
- `ocrPreflight`: sanitized `TASK9_EXPECT=preflight` live OCR boundary probe output
- `ocrDownProbe`: `service-fault-check.mjs --expect-down=ocr-service`
- `ocrFailureObserved`: sanitized `TASK9_EXPECT=down` live OCR boundary probe output
- `workerAliveOcr`: set `{ "ok": true, "checkedAt": "<ISO timestamp>", "evidenceType": "worker-alive-ocr", "note": "..." }` after proving the worker stayed alive while OCR was down
- `ocrDownPublish`: controlled publisher output using `--step=ocr-down`
- `ocrDownOutbox`: hash-bound outbox evidence using `--expect-sent --max-pending=0`
- `ocrRecoveryObserved`: sanitized `TASK9_EXPECT=up` live OCR boundary probe output

Use UTC ISO timestamps from each manual worker observation or probe output, and do not pre-fill future timestamps. The evidence checker verifies that baseline worker evidence happens before the baseline publish, LINE-outage worker evidence happens after the failed outbox attempt and before LINE recovery, and the OCR chain is strictly ordered as `ocrPreflight < ocrDownProbe < ocrFailureObserved < workerAliveOcr < ocrDownPublish < ocrDownOutbox < ocrRecoveryObserved`. Equal or reordered OCR timestamps fail the bundle.

The live drill always collects each command output as a separate bound file:

```bash
node "$TASK9_ACTIVE_PROJECTION/scripts/service-fault-evidence-check.mjs" --help
node "$TASK9_ACTIVE_PROJECTION/scripts/service-fault-evidence-check.mjs" \
  --environment="$TASK9_ENVIRONMENT" --dir-manifest
```

`--help` prints the safe Task 9 evidence flow without evidence placeholders or raw values. `--init-dir` creates the exact per-step evidence files from the checker template and refuses to run if the target directory already contains files, so existing operator evidence is not overwritten. Replace each placeholder file with the matching sanitized command output from the manifest, including `ocr-down-publish.json`, `ocr-down-outbox.json`, and `worker-alive-ocr.json`. Update `drill-metadata.json` with the real rollout metadata, for example `{ "drillId": "split-service-fault-drill-20260707-1000", "environment": "staging", "note": "..." }`; leaving the scaffold `YYYYMMDD-HHMM` placeholder in `drillId` fails `drillMetadata`. For the three manual worker checks, write a minimal timestamped JSON object with the required `evidenceType` to:

- `worker-baseline.json`
- `worker-alive.json`
- `worker-alive-ocr.json`

The OCR boundary files are not manual observations: collect them from the probe and service check as `ocr-preflight.json`, `ocr-down-probe.json`, `ocr-failure-observed.json`, and `ocr-recovery-observed.json`. `worker-alive-ocr.json` is the separate manual worker observation; `ocr-down-publish.json` and `ocr-down-outbox.json` must be the sanitized script outputs. Do not recreate line-service between boundary probe steps because the probe-bound preflight state is local to that container and expires after 30 minutes.

While collecting evidence, check directory readiness without echoing evidence contents:

```bash
node "$TASK9_ACTIVE_PROJECTION/scripts/service-fault-evidence-check.mjs" \
  --environment="$TASK9_ENVIRONMENT" --dir-status="$TASK9_EVIDENCE_DIR"
```

`--dir-status` reports only filename/key readiness metadata: missing files, invalid JSON files, placeholder files, ready counts, and `nextRequiredEvidence` for the next file/key to fix in drill order. Once every evidence file is structurally ready, it also reports `semanticStatus` with pass/fail counts and failed check names so operators can correct evidence before the final `--dir` validation. It intentionally does not print raw command output, event keys, notes, LINE targets, payloads, or secrets.

Then validate the evidence directory:

```bash
node "$TASK9_ACTIVE_PROJECTION/scripts/service-fault-evidence-check.mjs" \
  --environment="$TASK9_ENVIRONMENT" --dir="$TASK9_EVIDENCE_DIR"
```

The evidence checker is read-only and prints only checklist pass/fail metadata. It does not echo raw evidence values, and it rejects evidence objects that still contain common unsafe raw fields.

The evidence checker requires all three publishes to share the same drill/team/node identity while using distinct deterministic `eventKey` values. Outbox checks are hash-bound to their matching publisher output: `baselineOutbox` matches `baselinePublish`; `lineDownOutbox` and `lineRecoveryOutbox` match `lineDownPublish`; and `ocrDownOutbox` matches `ocrDownPublish`. Outbox evidence with fixture mode, missing or broader-than-runbook lookup windows, missing DB configuration, expectation failures, mismatched expectation flags, missing rollout metadata, or local-only metadata is rejected even if aggregate counts look plausible.

`service-fault-publish-notification.mjs` is intentionally mutating and requires `--confirm-send-test-notification`; use the raw publisher only in staging. `service-fault-outbox-check.mjs` is read-only. It prints aggregate `notification_outbox` counts, expectation failures, and a SHA-256 hash of the event-key filter only; it does not print notification targets, message bodies, payload JSON, DB credentials, raw event-key filters, or raw error text.

#### Production safe-target Task 9

> **Authorized protected-evidence handoff:** do not request Gate 6 approval until
> every applicable producer-map entry has completed the reviewed three-commit
> activation and the protected environment has approved the exact role-specific SHA.
> Repository-only or manually uploaded JSON remains invalid. Use only independently
> attested artifacts selected by their immutable artifact/run ID pairs, in this exact
> order:

1. Build and attest the exact immutable release artifact and both target descriptors.
2. Deploy that release to staging, complete Gates 1-5 and N-1 for the same release,
   then export the protected staging artifact.
3. Under the shared production concurrency boundary, produce fresh encrypted-backup
   and isolated-restore evidence with the fixed, independently pinned executables and
   read-only source/KMS capabilities.
4. Pass that backup artifact ID/run ID pair to the protected production deploy before
   any production mutation.
5. Capture and attest the protected-install artifact while the durable database slot
   and host lock remain held.
6. Create Gate 6 approval from the exact release, target, staging, backup, and install
   artifact ID/run ID pairs.
7. After the accepted DB transition, export its exact protected artifact and use it
   to issue the one-shot LINE and OCR permits.
8. After accepted pre-close, export its exact protected artifact and use it to issue
   the post-proof actions.
9. Seal the run, export the final-verifier artifact while the database slot and host
   lock are still sealed, then deliver the approval and verifier artifact ID/run ID
   pairs to the release controller.
10. Confirm cleanup releases the database slot transactionally and clears the durable
    host lock last.

Do not skip, reorder, or replace an artifact pair in this handoff. The sequence
describes the authorized boundary; every consumer also requires the artifact REST
metadata and the attestation certificate to name that same run ID. It does not itself
authorize a live workflow, backup, restore, KMS, database, SSH, or production operation.

Production Task 9 is a Gate 6 runtime canary. Never stop production LINE or OCR,
never use the staging fault controller, and never run raw
`task9_compose stop` or `task9_compose start` commands. The admitted Gate 6
envelope, current monitor lease, exact immutable release, distinct action
approvals, and just-in-time one-shot permits must all verify before a boundary
action can run.

Run the approved sequence from the installed production operator bundle. Each
controller action is resumable and writes sanitized evidence to the active
Gate 6 ledger; a failed or expired signature, reused permit, stage mismatch,
or lost monitor lease fails closed:

```bash
node scripts/production-task9-controller.mjs \
  --action=line-baseline \
  --envelope=/root/spx-rollout/gate6/gate6-envelope.json \
  --action-approval=/root/spx-rollout/gate6/actions/task9-line-baseline.json \
  --release=/root/spx-rollout/release-manifest.json

node scripts/production-task9-controller.mjs \
  --action=line-boundary-retry \
  --envelope=/root/spx-rollout/gate6/gate6-envelope.json \
  --action-approval=/root/spx-rollout/gate6/actions/task9-line-boundary.json \
  --permit=/root/spx-rollout/gate6/permits/task9-line-boundary.json \
  --release=/root/spx-rollout/release-manifest.json

node scripts/production-task9-controller.mjs \
  --action=ocr-boundary-recovery \
  --envelope=/root/spx-rollout/gate6/gate6-envelope.json \
  --action-approval=/root/spx-rollout/gate6/actions/task9-ocr-boundary.json \
  --permit=/root/spx-rollout/gate6/permits/task9-ocr-boundary.json \
  --release=/root/spx-rollout/release-manifest.json

node scripts/gate6-runtime-control.mjs \
  --action=verify-task9 \
  --action-approval=/root/spx-rollout/gate6/actions/stage-accept-task9.json \
  --evidence-dir=/root/spx-rollout/gate6/evidence/task9-production \
  --envelope=/root/spx-rollout/gate6/gate6-envelope.json \
  --release=/root/spx-rollout/release-manifest.json
```

## DB-first config

Production loads operator config from MySQL `app_settings` after reading bootstrap env. `.env` should contain only bootstrap values such as `NODE_ENV`, `DB_MODE`, database connection fields, and `SECRETS_KEY`. Docker/service environment or mounted secret files must keep process identity and trust-boundary values such as `SPX_ROLE`, `SPX_NODE_ID`, `RUN_TEAM_IDS`, `NOTIFIER_API_URL`, `NOTIFICATION_NODE_SECRET`, receiver node-secret maps/allowlists, OCR node secrets/classifications, and `HTTP_PORT`.

Use the dashboard Settings and Teams pages to change SPX API, polling, auto-accept, notification behavior, dashboard auth secrets, and team credentials. Per-node HMAC keys and OCR provider controls are process-local and require an orchestrated process restart. Before reducing `.env`, deploy the DB-first build once with the existing `.env` so startup can seed missing `app_settings` rows. Verify `/ready`, worker healthchecks, and Settings page values. After that verification, remove runtime/operator values from `.env`.

Current production has completed that rollout: `.env` should stay bootstrap-only, runtime/operator settings should come from `app_settings`, and team credentials/LINE targets should come from encrypted `teams` fields.

## Post-Deploy Verification

Run the immutable production preamble from this document first. These checks read the installed release context and Docker metadata; they do not depend on a Git checkout and do not print secret values:

```bash
EXPECTED_SOURCE_SHA="$(node -e '
  const context = require(process.argv[1]);
  if (!/^[0-9a-f]{40}$/.test(context.sourceSha ?? "")) process.exit(1);
  process.stdout.write(context.sourceSha);
' "$RELEASE_PARENT/deployment-context.json")"
EXPECTED_IMAGE_ID="$(node -e '
  const context = require(process.argv[1]);
  if (!/^sha256:[0-9a-f]{64}$/.test(context.imageId ?? "")) process.exit(1);
  process.stdout.write(context.imageId);
' "$RELEASE_PARENT/deployment-context.json")"
EXPECTED_MANIFEST_SHA256="$(node -e '
  const context = require(process.argv[1]);
  if (!/^[0-9a-f]{64}$/.test(context.releaseManifestSha256 ?? "")) process.exit(1);
  process.stdout.write(context.releaseManifestSha256);
' "$RELEASE_PARENT/deployment-context.json")"
test "$(basename "$RELEASE_PARENT")" = "$EXPECTED_SOURCE_SHA"
test "$(sha256sum "$SPX_RELEASE_MANIFEST_PATH" | awk '{print $1}')" = "$EXPECTED_MANIFEST_SHA256"
spx_production_compose --profile split ps \
  web-api notification-service line-service ocr-service \
  worker-ptwl-split
for service in web-api notification-service line-service ocr-service worker-ptwl-split; do
  container="$(spx_production_compose --profile split ps -q "$service")"
  test -n "$container"
  test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")" = spx-production
  test "$(docker inspect --format '{{.Image}}' "$container")" = "$EXPECTED_IMAGE_ID"
  test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")" = healthy
done
curl --fail --silent --show-error http://127.0.0.1:3000/ready >/dev/null
test "$(spx_production_compose --profile split logs --since=5m notification-service | grep -c 'POST /internal/runtime-metrics 200')" -gt 0
test "$(spx_production_compose --profile split logs --since=5m worker-ptwl-split | grep -c 'runtime-metrics-publish-failed\|runtime-metrics-url-invalid')" -eq 0
```

On `147.50.240.44`, inspect the root-owned TEAM 2 state written by the protected
installer and verify the one container it names:

```bash
TEAM2_STATE=/var/lib/spx-production-team2-rollout/state.json
test -f "$TEAM2_STATE" && test ! -L "$TEAM2_STATE"
TEAM2_CONTAINER="$(node -p 'require(process.argv[1]).containerId' "$TEAM2_STATE")"
TEAM2_IMAGE_ID="$(node -p 'require(process.argv[1]).imageId' "$TEAM2_STATE")"
test "$(docker inspect --format '{{.Image}}' "$TEAM2_CONTAINER")" = "$TEAM2_IMAGE_ID"
test "$(docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}|{{.RestartCount}}' "$TEAM2_CONTAINER")" = 'running|healthy|0'
test "$(docker exec "$TEAM2_CONTAINER" printenv SPX_ROLE RUN_TEAM_IDS SPX_NODE_ID | paste -sd '|')" = 'worker|2|prod-worker-ifn-node2'
test "$(docker ps -q --filter label=com.docker.compose.service=worker-ifn | wc -l)" -eq 0
test "$(docker ps -q --filter label=com.docker.compose.service=worker-ifn-split | wc -l)" -eq 1
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/internal/notification-events)" != 000
```

Expected runtime state:

- The active projection SHA, manifest digest, image ID, Compose project label, and container health all match the verified immutable deployment context.
- The primary runs `web-api`, `notification-service`, `line-service`, `ocr-service`, and `worker-ptwl-split`; only `web-api` is public.
- `147.50.240.44` runs exactly one `worker-ifn-split`, no legacy `worker-ifn`, no published port, and a fresh TEAM 2 lease.
- `/ready` returns HTTP 200 with `ready: true`.
- `POST /internal/runtime-metrics 200` appears frequently in the legacy `notifier` logs or split `notification-service` logs.
- Worker logs on both hosts have zero runtime-metrics publish/url failures.
- Admin Pipeline telemetry should update after the next worker metrics publish cycle; hard-refresh the dashboard if the browser still has stale UI state.

## Production Checklist

> [!warning] สิ่งที่ต้องทำก่อน deploy production

- [ ] ตั้งค่า `.env` เฉพาะ bootstrap values และตั้ง process identity values ใน Docker/service environment (ดู [[env-reference]])
- [ ] ใช้ process manager (PM2, systemd, Docker restart policy)
- [ ] Run `npm run db:migrate` ก่อน startup
- [ ] ตั้ง `HTTP_ALLOWED_ORIGINS` ผ่าน Settings สำหรับ non-localhost domain
- [ ] ตั้ง `NODE_ENV=production` สำหรับ secure cookies
- [ ] DB-backed operator/team secrets อยู่ใน `app_settings` หรือ encrypted team fields; per-node HMAC keys อยู่เฉพาะ process secret files/environment
- [ ] Monitor `/health`, `/ready`, `/metrics` ผ่าน Uptime Kuma หรือ Datadog
- [ ] Verify the notifier/notification-service receives worker runtime metrics (`POST /internal/runtime-metrics 200`) after deploy
- [ ] Create both production descriptors from the same release (`deployment_unit=primary` and `deployment_unit=team2`)
- [ ] Provision and independently pin the TEAM 2 target facts, host identity, SSH known-hosts digest, trusted workflow SHA, and root SSH deployment principal
- [ ] Verify the managed private tunnel on `147.50.240.44` listens on `127.0.0.1:3000` before activation
- [ ] Confirm the A3 dispatcher and provenance-attested `team2-deployment.json` both reference the same source SHA and image ID
- [ ] Confirm the primary has no `worker-ifn`/`worker-ifn-split` and TEAM 2 has exactly one `worker-ifn-split`
- [ ] `notify-rules.json` ต้องมี controlled write access เฉพาะ local/dev fallback; production rules อยู่ใน DB
- [ ] ตรวจว่า `npm run build` ผ่านก่อน release (includes typecheck + frontend build)
- [ ] ตรวจว่า `dist/public/` มี `index.html` และ assets ครบ

## Process Manager

> [!tip] Settings reload behavior
> Settings API เขียน DB แล้ว sync กลับเข้า process env ตาม metadata ของแต่ละ key: บางค่าเป็น live reload และบางค่าต้อง restart worker/process เช่น `JWT_SECRET`, `COOKIE_SECRET`, `NOTIFIER_AUTH_MODE`, และ `HTTP_ALLOWED_ORIGINS`. Per-node HMAC keys และ `HTTP_ENABLED` เป็น process-local service config ไม่ใช่ DB-backed Settings keys.
> การใช้ process manager (Docker, PM2, systemd) ยังแนะนำสำหรับ crash recovery, restart orchestration, และ availability ทั่วไป

## Frontend Build Output

```
dist/
├── app.js              # Backend bundle
├── scripts/            # CLI scripts
└── public/             # SPA static files
    ├── index.html      # React SPA entry
    └── assets/         # JS/CSS chunks (hashed)
        ├── index-xxx.js
        └── index-xxx.css
```

Backend serve ไฟล์เหล่านี้ผ่าน `@fastify/static` + catch-all route สำหรับ client-side routing

## ดูเพิ่มเติม

- [[env-reference]] — ตัวแปร environment ทั้งหมด
- [[production-cautions]] — ข้อควรระวังใน production
- [[cheatsheet]] — คำสั่ง npm ที่ใช้บ่อย
- [[architecture]] — โครงสร้างระบบ
