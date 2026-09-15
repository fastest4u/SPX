import mysql from 'mysql2/promise'
import { readFileSync } from 'node:fs'
import { mysqlVerifiedTransport } from './lib/mysql-connection-config.mjs'

const teamId = Number(process.argv[2])
const nodeId = process.argv[3]
const startedAt = Date.parse(process.argv[4] ?? '')
const deadline = setTimeout(() => process.exit(1), 10_000)
let connection
try {
  if (teamId !== 2 || nodeId !== 'prod-worker-ifn-node2' || !Number.isFinite(startedAt)) {
    throw new Error('invalid TEAM 2 target')
  }
  if (process.env.SPX_ROLE !== 'worker' || process.env.RUN_TEAM_IDS !== '2'
    || process.env.SPX_NODE_ID !== nodeId) throw new Error('invalid TEAM 2 worker identity')
  const passwordFile = process.env.DB_PASSWORD_FILE
  if (!passwordFile) throw new Error('database password file is missing')
  if (process.env.DB_SSL_MODE !== 'verify-identity' || !process.env.DB_SSL_CA_FILE) {
    throw new Error('verified database TLS is required')
  }
  const startedSecond = new Date(startedAt).toISOString().slice(0, 19).replace('T', ' ')
  connection = await mysql.createConnection({
    ...mysqlVerifiedTransport(process.env.DB_HOST, Number(process.env.DB_PORT || 3306),
      process.env.DB_SSL_SERVERNAME || process.env.DB_HOST),
    user: process.env.DB_USERNAME,
    password: readFileSync(passwordFile, 'utf8').trimEnd(),
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL_CA_FILE ? {
      ca: readFileSync(process.env.DB_SSL_CA_FILE),
      servername: process.env.DB_SSL_SERVERNAME,
      rejectUnauthorized: true,
      verifyIdentity: true,
    } : undefined,
    connectTimeout: 5_000,
  })
  const [teams] = await connection.execute('SELECT enabled FROM teams WHERE id = 2')
  const [desired] = await connection.execute(
    'SELECT desired_state FROM team_runtime_desired_state WHERE team_id = 2')
  const [leases] = await connection.execute(
    'SELECT owner_node_id, lease_expires_at > UTC_TIMESTAMP() AS valid, '
    + 'TIMESTAMPDIFF(SECOND, heartbeat_at, UTC_TIMESTAMP()) AS age, '
    + 'heartbeat_at > ? AS renewed_since_start '
    + 'FROM team_runtime_leases WHERE team_id = 2', [startedSecond])
  const inactive = teams.length === 1 && (!teams[0].enabled || desired[0]?.desired_state === 'stopped')
  const ownsLease = leases[0]?.owner_node_id === nodeId && leases[0]?.valid === 1
    && leases[0].age >= 0 && leases[0].age <= 30 && leases[0].renewed_since_start === 1
  const ready = teams.length === 1 && (inactive || ownsLease)
  console.log(JSON.stringify({ ready, teamId, nodeId, inactive, ownsLease }))
  if (!ready) process.exitCode = 1
} catch {
  console.log(JSON.stringify({ ready: false, teamId, error: 'TEAM 2 database/lease readiness failed' }))
  process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  clearTimeout(deadline)
}
