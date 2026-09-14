import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "tms.pathwaylogistic.com",
    user: process.env.DB_USERNAME || "pmauser",
    password: process.env.DB_PASSWORD || "BangZero@99",
    database: process.env.DB_NAME || "SPX",
    port: Number(process.env.DB_PORT || 3306),
  });

  await conn.query("UPDATE teams SET enabled = 1 WHERE id IN (1, 2)");
  console.log("Enabled teams 1 and 2 in teams table.");

  await conn.query(`
    INSERT INTO team_runtime_desired_state (team_id, desired_state, reason, updated_at)
    VALUES (1, 'running', 'user requested run PTWL on server 1', NOW())
    ON DUPLICATE KEY UPDATE desired_state = 'running', reason = 'user requested run PTWL on server 1', updated_at = NOW()
  `);

  await conn.query(`
    INSERT INTO team_runtime_desired_state (team_id, desired_state, reason, updated_at)
    VALUES (2, 'running', 'user requested run IFN on server 2', NOW())
    ON DUPLICATE KEY UPDATE desired_state = 'running', reason = 'user requested run IFN on server 2', updated_at = NOW()
  `);

  const [desired] = await conn.query("SELECT * FROM team_runtime_desired_state");
  console.table(desired);

  const [teams] = await conn.query("SELECT id, name, enabled FROM teams WHERE id IN (1, 2)");
  console.table(teams);

  await conn.end();
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
