import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function build(outputPath: string) {
  return spawnSync(process.execPath, ['scripts/build-descriptor-signer.mjs', outputPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
}

test('builds a deterministic self-contained descriptor signer executable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spx-descriptor-signer-build-'))
  try {
    const firstPath = join(directory, 'signer-a.mjs')
    const secondPath = join(directory, 'signer-b.mjs')
    const first = build(firstPath)
    const second = build(secondPath)

    assert.equal(first.status, 0, first.stderr)
    assert.equal(second.status, 0, second.stderr)

    const firstBytes = readFileSync(firstPath)
    const secondBytes = readFileSync(secondPath)
    assert.deepEqual(firstBytes, secondBytes)
    assert.doesNotMatch(firstBytes.toString('utf8'), /\.\.\/src\/services\/deployment-target-descriptor/)

    const report = JSON.parse(first.stdout) as { outputPath: string, sha256: string }
    assert.equal(report.outputPath, firstPath)
    assert.equal(report.sha256, createHash('sha256').update(firstBytes).digest('hex'))

    const overwrite = build(firstPath)
    assert.equal(overwrite.status, 1)
    assert.deepEqual(readFileSync(firstPath), firstBytes)

    const bundled = await import(`${pathToFileURL(firstPath).href}?test=${Date.now()}`)
    assert.equal(typeof bundled.createDescriptorSignerServer, 'function')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
