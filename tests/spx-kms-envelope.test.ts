import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import test, { after } from 'node:test'

import { executeKmsEnvelope } from '../scripts/spx-kms-envelope.mjs'

const releaseSha = 'a'.repeat(40)
const databaseFingerprint = `sha256:${'b'.repeat(64)}`

function capture() {
  const chunks: Buffer[] = []
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }),
    bytes: () => Buffer.concat(chunks),
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'spx-kms-envelope-'))
  after(async () => {
    assert(root.startsWith(join(tmpdir(), 'spx-kms-envelope-')))
    await rm(root, { recursive: true, force: true })
  })
  await chmod(root, 0o700)
  const outputRoot = join(root, 'output')
  await mkdir(outputRoot, { mode: 0o700 })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyringPath = join(root, 'keyring.json')
  const capabilityPath = join(root, 'capability.json')
  await writeFile(keyringPath, JSON.stringify({
    schemaVersion: 1,
    keys: {
      'backup-encryption-v1': {
        algorithm: 'AES-256-GCM',
        keyBase64: randomBytes(32).toString('base64'),
      },
      'backup-evidence-v1': {
        algorithm: 'Ed25519',
        privateKeyPemBase64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
      },
    },
  }), { mode: 0o400 })
  await writeFile(capabilityPath, JSON.stringify({
    schemaVersion: 1,
    capabilityId: 'production-backup-v1',
    grants: [
      { operation: 'encrypt', keyId: 'backup-encryption-v1' },
      { operation: 'decrypt', keyId: 'backup-encryption-v1' },
      { operation: 'sign', keyId: 'backup-evidence-v1' },
    ],
  }), { mode: 0o400 })
  if (process.platform !== 'win32') {
    await chmod(keyringPath, 0o400)
    await chmod(capabilityPath, 0o400)
  }
  return {
    root,
    outputRoot,
    keyringPath,
    capabilityPath,
    publicKey,
    options: { keyringPath, allowNonRoot: process.platform === 'win32' || process.getuid?.() !== 0 },
  }
}

function encryptionArgs(f: Awaited<ReturnType<typeof fixture>>) {
  return [
    'encrypt',
    '--capability-file', f.capabilityPath,
    '--key-id', 'backup-encryption-v1',
    '--release-sha', releaseSha,
    '--database-fingerprint', databaseFingerprint,
    '--ciphertext-output', join(f.outputRoot, 'backup.bin'),
    '--metadata-output', join(f.outputRoot, 'encryption-metadata.json'),
  ]
}

test('streams an authenticated backup round trip and signs the exact evidence hash', async () => {
  const f = await fixture()
  const plaintext = Buffer.concat([
    Buffer.from('CREATE TABLE example (id bigint);\n'),
    randomBytes(2 * 1024 * 1024),
  ])
  await executeKmsEnvelope(encryptionArgs(f), {
    ...f.options,
    stdin: Readable.from([plaintext.subarray(0, 13), plaintext.subarray(13)]),
  })

  const metadata = JSON.parse(await readFile(join(f.outputRoot, 'encryption-metadata.json'), 'utf8'))
  assert.equal(metadata.schemaVersion, 1)
  assert.equal(metadata.algorithm, 'AES-256-GCM')
  assert.equal(metadata.releaseSha, releaseSha)
  assert.equal(metadata.databaseFingerprint, databaseFingerprint)
  assert.match(metadata.plaintextSha256, /^[0-9a-f]{64}$/)
  assert.match(metadata.ciphertextSha256, /^[0-9a-f]{64}$/)

  const restored = capture()
  await executeKmsEnvelope([
    'decrypt',
    '--capability-file', f.capabilityPath,
    '--key-id', 'backup-encryption-v1',
    '--release-sha', releaseSha,
    '--database-fingerprint', databaseFingerprint,
    '--input', join(f.outputRoot, 'backup.bin'),
  ], { ...f.options, stdout: restored.stream })
  assert.deepEqual(restored.bytes(), plaintext)

  const subjectSha256 = 'c'.repeat(64)
  const signed = capture()
  await executeKmsEnvelope([
    'sign',
    '--capability-file', f.capabilityPath,
    '--key-id', 'backup-evidence-v1',
    '--subject-sha256', subjectSha256,
  ], { ...f.options, stdout: signed.stream })
  const response = JSON.parse(signed.bytes().toString('utf8'))
  assert.deepEqual(Object.keys(response), ['signatureBase64'])
  assert.equal(
    verify(null, Buffer.from(subjectSha256, 'hex'), f.publicKey, Buffer.from(response.signatureBase64, 'base64')),
    true,
  )
})

test('rejects capability escalation, tampering, context mismatch, and unknown arguments', async () => {
  const f = await fixture()
  await assert.rejects(
    executeKmsEnvelope([
      'sign', '--capability-file', f.capabilityPath,
      '--key-id', 'backup-encryption-v1', '--subject-sha256', 'd'.repeat(64),
    ], f.options),
    /capability-denied/,
  )
  await assert.rejects(
    executeKmsEnvelope([...encryptionArgs(f), '--surprise', '1'], {
      ...f.options,
      stdin: Readable.from(['secret']),
    }),
    /arguments-invalid/,
  )

  await executeKmsEnvelope(encryptionArgs(f), {
    ...f.options,
    stdin: Readable.from(['authenticated']),
  })
  const ciphertextPath = join(f.outputRoot, 'backup.bin')
  const ciphertext = await readFile(ciphertextPath)
  ciphertext[0] ^= 0xff
  await writeFile(ciphertextPath, ciphertext)
  await assert.rejects(
    executeKmsEnvelope([
      'decrypt', '--capability-file', f.capabilityPath,
      '--key-id', 'backup-encryption-v1', '--release-sha', releaseSha,
      '--database-fingerprint', databaseFingerprint, '--input', ciphertextPath,
    ], { ...f.options, stdout: capture().stream }),
    /ciphertext-invalid/,
  )
})

test('removes incomplete outputs when its input stream fails', async () => {
  const f = await fixture()
  const failing = new Readable({
    read() {
      this.push('partial plaintext')
      this.destroy(new Error('simulated input failure'))
    },
  })
  await assert.rejects(
    executeKmsEnvelope(encryptionArgs(f), { ...f.options, stdin: failing }),
    /kms-operation-failed/,
  )
  await assert.rejects(readFile(join(f.outputRoot, 'backup.bin')), /ENOENT/)
  await assert.rejects(readFile(join(f.outputRoot, 'encryption-metadata.json')), /ENOENT/)
})

test('emits no restore bytes when authentication or plaintext metadata fails', async () => {
  for (const field of ['authTagBase64', 'plaintextSha256', 'releaseSha']) {
    const f = await fixture()
    await executeKmsEnvelope(encryptionArgs(f), {
      ...f.options, stdin: Readable.from([randomBytes(1024 * 1024)]),
    })
    const path = join(f.outputRoot, 'encryption-metadata.json')
    const metadata = JSON.parse(await readFile(path, 'utf8'))
    metadata[field] = field === 'authTagBase64' ? randomBytes(16).toString('base64')
      : 'e'.repeat(field === 'releaseSha' ? 40 : 64)
    await writeFile(path, JSON.stringify(metadata))
    const restored = capture()
    await assert.rejects(executeKmsEnvelope([
      'decrypt', '--capability-file', f.capabilityPath,
      '--key-id', 'backup-encryption-v1', '--release-sha', releaseSha,
      '--database-fingerprint', databaseFingerprint,
      '--input', join(f.outputRoot, 'backup.bin'),
    ], { ...f.options, stdout: restored.stream }), /ciphertext-invalid|metadata-invalid/)
    assert.equal(restored.bytes().length, 0)
  }
})

test('requires protected capability and keyring file modes on POSIX', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture()
  await chmod(f.capabilityPath, 0o600)
  await assert.rejects(
    executeKmsEnvelope([
      'sign', '--capability-file', f.capabilityPath,
      '--key-id', 'backup-evidence-v1', '--subject-sha256', 'e'.repeat(64),
    ], f.options),
    /protected-file-invalid/,
  )
})
