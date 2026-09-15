# A3 owner KMS and signer bootstrap design

## Goal

Remove the remaining owner-managed production prerequisites for the protected A3 deployment without placing long-lived private keys or database passwords in GitHub Actions, repository files, logs, or artifacts.

## Trust boundaries

The primary production host owns three capabilities:

1. A loopback-only descriptor signer validates GitHub Actions OIDC tokens and signs only canonical deployment target descriptors for `fastest4u/SPX` trusted workflow runs.
2. A fixed local envelope helper encrypts and decrypts production backup streams and signs evidence hashes. Its keyring remains under `/etc/spx-kms` and is never readable by CI.
3. A one-time owner bootstrap creates restricted database principals through the database host's local owner socket and writes root-only credential projections. It never prints generated passwords.

Nginx exposes only the descriptor signing endpoint over the existing production TLS virtual host. The signer process binds to `127.0.0.1`, accepts one exact route and method, applies request and time limits, validates the JWT signature against GitHub's JWKS, then enforces issuer, audience, repository, environment subject, and immutable workflow identity claims.

## Cryptography

- Descriptor and evidence signatures use Ed25519 keys.
- Backup encryption uses a dedicated random 256-bit key with AES-256-GCM, a fresh 96-bit IV, a 128-bit authentication tag, and authenticated canonical metadata bound to the release SHA and database fingerprint.
- Encryption and decryption stream data; plaintext backups are never written to disk.
- Each operation is authorized by an exact root-owned capability document that binds operation to key ID.
- Ciphertext and metadata outputs are created exclusively and published atomically. Failed operations remove incomplete outputs.

## Files and ownership

- `/usr/local/libexec/spx-kms-envelope`: root-owned executable, digest pinned in the protected workflow configuration.
- `/etc/spx-kms/keyring.json`: root-owned mode `0400` keyring.
- `/run/credentials/spx-production-backup-kms.json`: root-owned mode `0400`, grants backup encrypt/decrypt and evidence sign only.
- `/run/credentials/spx-protected-install-evidence-kms.json`: root-owned mode `0400`, grants protected-install evidence sign only.
- `/run/credentials/spx-production-backup-source.cnf`: root-owned mode `0400`, restricted read/lock backup account.
- `/etc/spx-descriptor-signer/config.json`: root-owned mode `0400`, public policy plus a private-key file reference.
- `/etc/spx-descriptor-signer/private-key.pem`: root-owned mode `0400`.

## Failure behavior

All validation fails closed. Errors sent to callers and logs contain stable reason codes without tokens, keys, passwords, request payloads, or command output. Existing workers remain active until the protected deploy passes backup, descriptor, migration, readiness, and singleton-poller gates. Rollback uses the existing A3 protected installer and production identity controls.

## Deployment sequence

1. Review and merge the owner tooling.
2. Install the fixed helper and signer on the primary host and pin their digests.
3. Create backup and service database principals and root-only credential files.
4. Publish the signer public key and endpoint policy to GitHub environment variables.
5. Capture exact live target facts and current production identity approval.
6. Refresh the reviewed Stage C dispatcher activation to the merged trusted workflow SHAs, then merge it.
7. Build the immutable release, sign both descriptors, run encrypted backup and isolated restore, adopt production identity, then deploy primary and TEAM 2.
8. Verify migrations, health, leases, routing, rollback state, and exactly one poller per team.
