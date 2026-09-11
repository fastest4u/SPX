import mysql from 'mysql2/promise'

// Read existing bootstrap variables inside the worker; never read or print .env.
const teamId = Number(process.argv[2])
const nodeId = process.argv[3]
const startedAt = Date.parse(process.argv[4] ?? '')
const deadline = setTimeout(() => process.exit(1), 10_000)
let connection
try {
  if (!Number.isSafeInteger(teamId) || teamId < 1 || !nodeId || !Number.isFinite(startedAt)) throw new Error('invalid target')
  if (process.env.SPX_ROLE !== 'worker' || process.env.RUN_TEAM_IDS !== String(teamId)
    || process.env.SPX_NODE_ID !== nodeId) throw new Error('invalid worker identity')
  // DATETIME heartbeats have second precision. Require a later whole second,
  // rather than accepting a stale heartbeat from the container's start second.
  const startedSecond = new Date(startedAt).toISOString().slice(0, 19).replace('T', ' ')
  connection = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, connectTimeout: 5_000,
  })
  const [teams] = await connection.execute('SELECT enabled FROM teams WHERE id = ?', [teamId])
  const [desired] = await connection.execute(
    'SELECT desired_state FROM team_runtime_desired_state WHERE team_id = ?', [teamId])
  const [leases] = await connection.execute(
    'SELECT owner_node_id, lease_expires_at > UTC_TIMESTAMP() AS valid, '
    + 'TIMESTAMPDIFF(SECOND, heartbeat_at, UTC_TIMESTAMP()) AS age, '
    + 'heartbeat_at > ? AS renewed_since_start '
    + 'FROM team_runtime_leases WHERE team_id = ?', [startedSecond, teamId])
  const inactive = teams.length === 1 && (!teams[0].enabled || desired[0]?.desired_state === 'stopped')
  const ownsLease = leases[0]?.owner_node_id === nodeId && leases[0]?.valid === 1
    && leases[0].age >= 0 && leases[0].age <= 30 && leases[0].renewed_since_start === 1
  const ready = teams.length === 1 && (inactive || ownsLease)
  console.log(JSON.stringify({ ready, teamId, nodeId, inactive, ownsLease }))
  if (!ready) process.exitCode = 1
} catch {
  console.log(JSON.stringify({ ready: false, teamId, error: 'worker database/lease readiness failed' }))
  process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  clearTimeout(deadline)
}
