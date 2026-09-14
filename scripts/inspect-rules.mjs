import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "tms.pathwaylogistic.com",
    user: process.env.DB_USERNAME || "pmauser",
    password: process.env.DB_PASSWORD || "BangZero@99",
    database: process.env.DB_NAME || "SPX",
    port: Number(process.env.DB_PORT || 3306),
  });

  const [cols] = await conn.query("SHOW COLUMNS FROM notify_rules");
  console.log("Columns:", cols.map(c => c.Field));

  const [rules] = await conn.query("SELECT * FROM notify_rules WHERE team_id = 2 AND enabled = 1");
  for (const r of rules) {
    console.log({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      need: r.need,
      accept_all: r.accept_all,
      origins: r.origins,
      destinations: r.destinations,
      vehicle_types: r.vehicle_types,
    });
  }

  await conn.end();
}

main().catch(console.error);
