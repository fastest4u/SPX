import assert from 'node:assert/strict'
import { loadConfigFromFile, resolveConfig } from 'vite'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function run() {
  const fixture = mkdtempSync(join(tmpdir(), 'spx-vite-env-'))
  try {
    writeFileSync(join(fixture, '.env'), 'VITE_SYNTHETIC_SENTINEL=must-not-load\n')
    process.env.SPX_TEST_SKIP_ENV_FILE = '1'
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve('vite.config.ts'))
    assert.ok(loaded)
    assert.equal(loaded.config.envDir, false, 'explicit build opt-out must disable Vite env files')
    const resolved = await resolveConfig({ ...loaded.config, root: fixture, configFile: false, plugins: [] }, 'build', 'production')
    assert.equal(resolved.env.VITE_SYNTHETIC_SENTINEL, undefined)
    delete process.env.SPX_TEST_SKIP_ENV_FILE
    const normal = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve('vite.config.ts'))
    assert.equal(normal?.config.envDir, undefined, 'normal env loading remains the Vite default')
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}
run().catch((error) => { console.error(error); process.exit(1) })
