import type { FastifyPluginAsync } from "fastify";
import { readEnvFile, writeEnvFile } from "../services/settings.js";
import { insertAuditLog } from "../repositories/audit-repository.js";

const settingsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    API_URL: { type: "string" },
    COOKIE: { type: "string" },
    DEVICE_ID: { type: "string" },
    LINE_NOTIFY_TOKEN: { type: "string" },
    DISCORD_WEBHOOK_URL: { type: "string" },
    POLL_INTERVAL_MS: { type: "string" },
  },
} as const;

export const settingsController: FastifyPluginAsync = async (app) => {
  app.get("/", async () => {
    const envVars = readEnvFile();
    return {
      API_URL: envVars.API_URL || "",
      COOKIE: envVars.COOKIE || "",
      DEVICE_ID: envVars.DEVICE_ID || "",
      LINE_NOTIFY_TOKEN: envVars.LINE_NOTIFY_TOKEN || "",
      DISCORD_WEBHOOK_URL: envVars.DISCORD_WEBHOOK_URL || "",
      POLL_INTERVAL_MS: envVars.POLL_INTERVAL_MS || "30000",
    };
  });

  app.post(
    "/",
    { schema: { body: settingsSchema } },
    async (req: any, reply) => {
      const data = req.body as Record<string, string>;
      writeEnvFile(data);
      await insertAuditLog(req.user.username, "Update Settings", "Updated .env configuration (Server Restarted)");

      setTimeout(() => {
        console.log("Settings updated via API. Triggering immediate restart...");
        process.exit(0);
      }, 1000);

      return { ok: true, message: "Settings saved. Server is restarting..." };
    }
  );
};
