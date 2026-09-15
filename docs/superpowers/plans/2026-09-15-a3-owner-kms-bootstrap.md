# A3 owner KMS and signer bootstrap implementation plan

1. Add executable-level tests for capability enforcement, secure-file checks, AES-GCM streaming round trip, tamper rejection, atomic cleanup, and Ed25519 evidence signing.
2. Implement `scripts/spx-kms-envelope.mjs` with a fixed production keyring path and injectable test ports only through imported functions.
3. Add signer tests for JWT/JWKS verification, immutable workflow and environment claims, digest binding, exact request/response shape, body limits, and secret-safe failures.
4. Implement `scripts/spx-descriptor-signer.mjs`, a deterministic self-contained bundle builder, its systemd unit, and an Nginx location fragment. Install only the generated bundle at `/usr/local/libexec/spx-descriptor-signer`.
5. Bootstrap root-only keys and capabilities on the owner host, then create restricted database principals without emitting credential values.
6. Run focused tests, lint, typecheck, full tests, and build; review and fix the complete diff.
7. Commit, push, open a pull request, run the SPX review workflow, and merge after the gates pass.
8. Install and verify the tooling on the primary host, configure exact GitHub environment values, and perform the protected production deployment sequence.
9. Verify both hosts and close project memory with concrete deployment evidence.
