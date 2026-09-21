# Deploy workers to their designated hosts

The `CI and Deploy` GitHub Actions workflow validates pull requests without deploying.
A successful push to `main` deploys the exact tested commit in this order:

1. Build, typecheck, lint, and tests.
2. Read-only preflight of each remote worker's existing identity and configuration.
3. Deploy the API/notifier and TEAM 1 on the primary host; require API readiness and
   a TEAM 1 lease heartbeat from the new container before accepting the release.
4. Export the primary container's image, verify its application bundle against the
   CI artifact, and transfer that same image to each remote worker.
5. Recreate only the designated worker and verify image, health, team/node identity,
   and a lease heartbeat from the new container. Roll back that worker on failure.

| Team | Host | Compose service | Node ID |
| --- | --- | --- | --- |
| TEAM 1 | `45.154.26.83` | `worker-ptwl` | `prod-worker-ptwl-node3` |
| TEAM 2 | `147.50.240.44` | `worker-ifn` | `prod-worker-ifn-node2` |

All hosts use `/root/SPX`. The primary (`45.83.207.139`) runs `notifier` (API/dashboard and LINE delivery).
Remote worker hosts run dedicated single-worker Compose projects connecting directly to MySQL.
Primary Compose operations explicitly name `notifier`, so they do not run worker pollers on the primary host.

## GitHub configuration

The existing primary secrets remain `SPX_HOST`, `SPX_PORT`, `SPX_USER`, and `SPX_SSH_KEY`.
`SPX_HOST` must identify the designated primary. Additional repository configuration:

| Type | Name | Purpose |
| --- | --- | --- |
| Secret | `SPX_TEAM2_SSH_KEY` | Dedicated TEAM 2 CI SSH private key |
| Variable | `SPX_TEAM2_KNOWN_HOSTS` | Verified SSH host public key for TEAM 2 |
| Variable | `SPX_TEAM2_OVERRIDE_SHA256` | Reviewed bootstrap override checksum, or `absent` |
| Variable | `SPX_PRIMARY_KNOWN_HOSTS` | Verified SSH host public key for the primary |
| Variable | `SPX_PRIMARY_HOST_FINGERPRINT` | Matching primary SSH SHA256 fingerprint |

The TEAM 2 public deploy key is installed with the `restrict` option. Verify host keys
over a trusted existing connection when provisioning or rotating them. Never place
private keys, passwords, cookies, or `.env` contents in the repository or job logs.

The deployment keeps existing bootstrap configuration, database/notification tunnels,
team credentials, data volumes, and polling settings. It adds a separate CI Compose
overlay for the verified image and designated worker identity. A deployment state file
records the successful release and configuration checksums. Configuration drift stops
deployment for operator review rather than silently replacing local settings.

On the remote host, manual Compose operations after enabling CI must include the CI
overlay, otherwise Compose would select the old bootstrap image:

```sh
cd /root/SPX
docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f docker-compose.ci-worker.yml ps worker-ifn
```

Omit the bootstrap override argument only when that file is absent. Deployment itself
uses these explicit files automatically; ordinary `docker compose up` is not the remote
production release procedure.

## Release and failure behavior

The `spx-worker-release` artifact includes the image archive, manifest, and deployment
helpers. The manifest binds the Git commit, image ID, bundle SHA256, and archive SHA256.
The image inspection helper runs with networking disabled. Release files on workers
are stored beneath `/root/SPX/releases/ci-<commit>-<run>-<attempt>`. Temporary image
archives on both hosts are removed after transfer/use; manifests and rollback metadata
remain available, and rollback uses the locally tagged Docker image.

Production workflow runs are serialized. Remote worker matrix jobs use
`fail-fast: false`; one worker's failure does not cancel another worker mid-rollout.
A worker failure restores its previous CI configuration and image and checks readiness
again. A failure of rollback is reported explicitly and requires operator investigation.
Successful deployment of another host is retained; this is not a cross-host transaction.

Disabled or deliberately stopped teams do not need an active lease. Active teams must
hold a valid lease for their designated node, with a heartbeat after container start.
Provider rate limits are not deployment readiness failures; this workflow does not
change polling intervals or accepting rules.

Use the GitHub Actions job result and the `worker-deployment-team-2` artifact to inspect
the outcome. When retrying, rerun the same workflow run to retain its commit identity.
Review configuration drift before changing the bootstrap checksum or deployment state.
Do not delete state merely to bypass a failed preflight.

The supported production dispatch topology is `legacy` (the existing combined API
and notifier). `split` is rejected before production changes because remote notification
routing needs a separate rollout for that topology.

## Add another remote team

Provision and verify its dedicated single-worker Compose project, runtime node, database
and notification connectivity first. Add a dedicated deploy key, pinned host key, and
reviewed bootstrap checksum. Extend the `remote_workers` matrix in
`.github/workflows/deploy.yml` with the team's host, service, node, and configuration
names; both preflight and deployment reuse that mapping. Update the routing regression
test and this host table in the same change.
