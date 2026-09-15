import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const source = readFileSync('scripts/ci-worker-readiness.mjs', 'utf8')
assert.match(source, /DB_PASSWORD_FILE/,
  'protected A3 workers must be able to read their file-mounted database password')
const startedAt = '2026-09-12T01:02:03.123456789Z'

function check(overrides: Record<string, unknown> = {}, start = startedAt, environment = {}) {
  const fixture = {
    enabled: 1, desired: 'running', node: 'worker-test', valid: 1, age: 1,
    heartbeat: '2026-09-12 01:02:04', lease: true, ...overrides,
  }
  // Replace only the external database transport; execute the actual CLI body
  // and its query parameters in a separate process with no database access.
  const transport = `const fixture = ${JSON.stringify(fixture)};
const mysql = { createConnection: async () => ({
  execute: async (sql, parameters) => {
    if (sql.includes('FROM teams')) return [[{enabled: fixture.enabled}]];
    if (sql.includes('FROM team_runtime_desired_state')) return [[{desired_state: fixture.desired}]];
    if (!fixture.lease) return [[]];
    const guarded = sql.includes('heartbeat_at > ? AS renewed_since_start');
    if (guarded && parameters[1] !== 2) throw new Error('query must bind the designated team');
    return [[{owner_node_id: fixture.node, valid: fixture.valid, age: fixture.age,
      renewed_since_start: guarded && fixture.heartbeat > parameters[0] ? 1 : 0}]];
  }, destroy() {}
}) }`
  const isolated = source.replace("import mysql from 'mysql2/promise'", transport)
  assert.notEqual(isolated, source, 'the database transport must be replaced before executing the probe')
  const result = spawnSync(process.execPath, ['--input-type=module', '-', '2', 'worker-test', start], {
    input: isolated, encoding: 'utf8', timeout: 15_000,
    env: { SPX_ROLE: 'worker', RUN_TEAM_IDS: '2', SPX_NODE_ID: 'worker-test', ...environment },
  })
  assert.ifError(result.error)
  const body = JSON.parse(result.stdout) as { ready: boolean }
  return { ready: body.ready, exit: result.status }
}

assert.deepEqual(check({ heartbeat: '2026-09-12 01:02:02' }), { ready: false, exit: 1 },
  'a recent lease belonging to the old container must not prove readiness')
assert.deepEqual(check({ heartbeat: '2026-09-12 01:02:03' }), { ready: false, exit: 1 },
  'second-resolution heartbeat in the container start second is still ambiguous')
assert.deepEqual(check(), { ready: true, exit: 0 })
assert.deepEqual(check({ node: 'another-worker' }), { ready: false, exit: 1 })
assert.deepEqual(check({ valid: 0 }), { ready: false, exit: 1 })
assert.deepEqual(check({ age: 31 }), { ready: false, exit: 1 })
assert.deepEqual(check({ enabled: 0, lease: false }), { ready: true, exit: 0 })
assert.deepEqual(check({ desired: 'stopped', lease: false }), { ready: true, exit: 0 })
assert.deepEqual(check({ desired: 'paused', lease: false }), { ready: false, exit: 1 })
assert.deepEqual(check({}, ''), { ready: false, exit: 1 })
assert.deepEqual(check({}, startedAt, { RUN_TEAM_IDS: '1' }), { ready: false, exit: 1 })
assert.deepEqual(check({}, startedAt, { SPX_ROLE: 'api' }), { ready: false, exit: 1 })
assert.deepEqual(check({}, startedAt, { SPX_NODE_ID: 'other-node' }), { ready: false, exit: 1 })
console.log('ci-worker-readiness: instance freshness, scope and inactive-team checks passed')
