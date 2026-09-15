import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createDescriptorSignerServer } from '../scripts/spx-descriptor-signer.mjs'
import { deploymentTargetFactsSha256 } from '../src/services/deployment-target-descriptor.js'
import { canonicalJson } from '../src/services/release-manifest.js'

const trustedSha = '4c0b0cf57481eda1c88ac754fa70500cf0fb59ad'
const audience = 'https://pathwaylogistic.com/_spx/descriptor-signer'
const issuer = 'https://token.actions.githubusercontent.com'
const route = '/_spx/descriptor-signer/v1/sign'

function descriptorPayload() {
  const value = JSON.parse(readFileSync('tests/fixtures/deployment-target-descriptor.complete.json', 'utf8'))
  Object.assign(value, {
    releaseEnvironment: 'production', runtimeEnvironment: 'production', composeProject: 'spx-production',
    signingWorkflowSourceSha: trustedSha,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })
  value.target.productionObserverPolicySha256 = null
  value.target.canonicalPaths = {
    releaseRoot: '/opt/spx-production/release', environmentFile: '/etc/spx-production/runtime.env',
    stateRoot: '/var/lib/spx-production-rollout',
  }
  value.database.name = 'SPX'
  const c = claims()
  value.signing = {
    repository: c.repository, workflowRef: c.job_workflow_ref, environment: 'production',
    subject: c.sub, audience: c.aud, issuer: c.iss, jobWorkflowRef: c.job_workflow_ref,
    jobWorkflowSha: c.job_workflow_sha,
  }
  value.targetFactsSha256 = deploymentTargetFactsSha256(value)
  return Buffer.from(canonicalJson(value))
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function jwt(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], claims: Record<string, unknown>, kid = 'github-test-key') {
  const header = base64urlJson({ alg: 'RS256', kid, typ: 'JWT' })
  const payload = base64urlJson(claims)
  const signingInput = `${header}.${payload}`
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`
}

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: issuer,
    aud: audience,
    sub: 'repo:fastest4u/SPX:environment:production',
    repository: 'fastest4u/SPX',
    repository_owner: 'fastest4u',
    job_workflow_ref: `fastest4u/SPX/.github/workflows/deployment-target-descriptor-signer.yml@${trustedSha}`,
    job_workflow_sha: trustedSha,
    workflow_ref: `fastest4u/SPX/.github/workflows/deployment-target-descriptor.yml@${trustedSha}`,
    workflow_sha: trustedSha,
    event_name: 'workflow_dispatch',
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    ...overrides,
  }
}

async function fixture(options: { jwksFailuresBeforeSuccess?: number } = {}) {
  const githubKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const signerKeys = generateKeyPairSync('ed25519')
  const jwk = githubKeys.publicKey.export({ format: 'jwk' })
  Object.assign(jwk, { kid: 'github-test-key', use: 'sig', alg: 'RS256' })
  let jwksRequests = 0
  const config = {
    schemaVersion: 1,
    listenHost: '127.0.0.1',
    listenPort: 0,
    path: route,
    keyId: 'spx-descriptor-v1',
    privateKeyPath: '/unused/in-tests',
    oidcIssuer: issuer,
    oidcAudience: audience,
    oidcJwksUrl: 'https://token.actions.githubusercontent.com/.well-known/jwks',
    repository: 'fastest4u/SPX',
    repositoryOwner: 'fastest4u',
    environments: ['production', 'staging'],
    trustedWorkflowSha: trustedSha,
    trustedWorkflowPath: '.github/workflows/deployment-target-descriptor-signer.yml',
    maximumBodyBytes: 16 * 1024,
    maximumTokenAgeSeconds: 600,
    clockToleranceSeconds: 30,
    jwksCacheSeconds: 300,
  }
  const server = createDescriptorSignerServer(config, {
    privateKey: signerKeys.privateKey,
    fetch: async () => {
      jwksRequests += 1
      if (jwksRequests <= (options.jwksFailuresBeforeSuccess ?? 0)) {
        return new Response('{"error":"temporary"}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    delay: async () => {},
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  return {
    githubKeys,
    signerKeys,
    server,
    jwksRequests: () => jwksRequests,
    url: `http://127.0.0.1:${address.port}${route}`,
  }
}

async function request(f: Awaited<ReturnType<typeof fixture>>, token: string, body: unknown) {
  return fetch(f.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('verifies GitHub OIDC provenance and signs only the digest-bound canonical descriptor', async () => {
  const f = await fixture()
  try {
    const payload = descriptorPayload()
    const response = await request(f, jwt(f.githubKeys.privateKey, claims()), {
      algorithm: 'Ed25519',
      descriptorSha256: createHash('sha256').update(payload).digest('hex'),
      payloadBase64: payload.toString('base64'),
    })
    assert.equal(response.status, 200)
    const signed = await response.json() as { keyId: string, signature: string }
    assert.deepEqual(Object.keys(signed).sort(), ['keyId', 'signature'])
    assert.equal(signed.keyId, 'spx-descriptor-v1')
    assert.equal(verify(null, payload, f.signerKeys.publicKey, Buffer.from(signed.signature, 'base64url')), true)
    assert.equal(f.jwksRequests(), 1)

    const second = await request(f, jwt(f.githubKeys.privateKey, claims()), {
      algorithm: 'Ed25519',
      descriptorSha256: createHash('sha256').update(payload).digest('hex'),
      payloadBase64: payload.toString('base64'),
    })
    assert.equal(second.status, 200)
    assert.equal(f.jwksRequests(), 1, 'JWKS is cached for the configured bounded interval')
  } finally {
    f.server.close()
  }
})

test('retries one transient JWKS failure before denying a valid request', async () => {
  const f = await fixture({ jwksFailuresBeforeSuccess: 1 })
  try {
    const payload = descriptorPayload()
    const response = await request(f, jwt(f.githubKeys.privateKey, claims()), {
      algorithm: 'Ed25519',
      descriptorSha256: createHash('sha256').update(payload).digest('hex'),
      payloadBase64: payload.toString('base64'),
    })
    assert.equal(response.status, 200)
    assert.equal(f.jwksRequests(), 2)
  } finally {
    f.server.close()
  }
})

test('fails closed for wrong audience, mutable workflow provenance, and digest mismatch', async () => {
  const f = await fixture()
  try {
    const payload = Buffer.from('{"schemaVersion":1}', 'utf8')
    const body = {
      algorithm: 'Ed25519',
      descriptorSha256: createHash('sha256').update(payload).digest('hex'),
      payloadBase64: payload.toString('base64'),
    }
    const invalidTokens = [
      jwt(f.githubKeys.privateKey, claims({ aud: 'https://attacker.invalid' })),
      jwt(f.githubKeys.privateKey, claims({
        job_workflow_ref: 'fastest4u/SPX/.github/workflows/deployment-target-descriptor-signer.yml@main',
      })),
      jwt(f.githubKeys.privateKey, claims({
        workflow_ref: `fastest4u/SPX/.github/workflows/other.yml@${trustedSha}`,
      })),
      jwt(f.githubKeys.privateKey, claims({ event_name: 'pull_request' })),
      jwt(f.githubKeys.privateKey, claims({ sub: 'repo:fastest4u/SPX:environment:development' })),
    ]
    for (const token of invalidTokens) {
      const response = await request(f, token, body)
      assert.equal(response.status, 403)
      assert.deepEqual(await response.json(), { error: 'request-denied' })
    }
    const mismatch = await request(f, jwt(f.githubKeys.privateKey, claims()), {
      ...body,
      descriptorSha256: 'f'.repeat(64),
    })
    assert.equal(mismatch.status, 400)
    assert.deepEqual(await mismatch.json(), { error: 'request-invalid' })
  } finally {
    f.server.close()
  }
})

test('rejects unknown fields, noncanonical payloads, wrong routes, and oversized bodies without echoing input', async () => {
  const f = await fixture()
  try {
    const token = jwt(f.githubKeys.privateKey, claims())
    const noncanonical = Buffer.from('{ "schemaVersion": 1 }', 'utf8')
    const noncanonicalResponse = await request(f, token, {
      algorithm: 'Ed25519',
      descriptorSha256: createHash('sha256').update(noncanonical).digest('hex'),
      payloadBase64: noncanonical.toString('base64'),
    })
    assert.equal(noncanonicalResponse.status, 400)

    const unknownField = await request(f, token, {
      algorithm: 'Ed25519', descriptorSha256: 'a'.repeat(64), payloadBase64: 'e30=', extra: 'secret-value',
    })
    assert.equal(unknownField.status, 400)
    assert.doesNotMatch(await unknownField.text(), /secret-value/)

    const oversized = await request(f, token, {
      algorithm: 'Ed25519', descriptorSha256: 'a'.repeat(64), payloadBase64: Buffer.alloc(20_000).toString('base64'),
    })
    assert.equal(oversized.status, 413)

    const wrongRoute = await fetch(f.url.replace('/v1/sign', '/v1/other'), { method: 'POST' })
    assert.equal(wrongRoute.status, 404)
  } finally {
    f.server.close()
  }
})

test('rejects arbitrary JSON and cross-environment descriptor signing', async () => {
  const f = await fixture()
  try {
    for (const [payload, subject] of [
      [Buffer.from('{"schemaVersion":1}'), 'production'],
      [descriptorPayload(), 'staging'],
    ] as const) {
      const response = await request(f, jwt(f.githubKeys.privateKey, claims({
        sub: `repo:fastest4u/SPX:environment:${subject}`,
      })), {
        algorithm: 'Ed25519', descriptorSha256: createHash('sha256').update(payload).digest('hex'),
        payloadBase64: payload.toString('base64'),
      })
      assert.equal(response.status, 400)
    }
  } finally { f.server.close() }
})

test('ships a loopback proxy and a capability-free hardened service', () => {
  const unit = readFileSync('deploy/systemd/spx-descriptor-signer.service', 'utf8')
  const nginx = readFileSync('deploy/nginx/spx-descriptor-signer.location.conf', 'utf8')
  assert.match(unit, /^User=root$/m)
  assert.match(unit, /^CapabilityBoundingSet=$/m)
  assert.match(unit, /^AmbientCapabilities=$/m)
  assert.match(unit, /^NoNewPrivileges=true$/m)
  assert.match(unit, /^ProtectSystem=strict$/m)
  assert.match(unit, /^MemoryDenyWriteExecute=true$/m)
  assert.match(unit, /--jitless \/usr\/local\/libexec\/spx-descriptor-signer/)
  assert.match(nginx, /^location = \/_spx\/descriptor-signer\/v1\/sign \{/m)
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:9463;/)
})
