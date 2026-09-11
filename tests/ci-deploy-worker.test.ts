import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const executable = process.platform === 'win32' ? 'python' : 'python3'
const result = spawnSync(executable, ['tests/ci_deploy_worker_test.py'], { stdio: 'inherit' })
assert.ifError(result.error)
assert.equal(result.status, 0, 'remote worker deployment safety/rollback regressions pass')
