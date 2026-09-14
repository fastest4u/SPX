import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "tms.pathwaylogistic.com",
    user: process.env.DB_USERNAME || "pmauser",
    password: process.env.DB_PASSWORD || "BangZero@99",
    database: process.env.DB_NAME || "SPX",
    port: Number(process.env.DB_PORT || 3306),
  });

  console.log("=== app_settings ===");
  const [settings] = await conn.query("SELECT setting_key, setting_value, updated_at FROM app_settings");
  for (const s of settings) {
    if (s.setting_key.includes("SECRET") || s.setting_key.includes("COOKIE") || s.setting_key.includes("PASS")) {
      console.log(`${s.setting_key}: [REDACTED]`);
    } else {
      console.log(`${s.setting_key}: ${s.setting_value}`);
    }
  }

  await conn.end();
}

main().catch(console.error);
