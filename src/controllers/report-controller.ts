import type { FastifyPluginAsync } from "fastify";
import { getBookingHistory } from "../repositories/booking-history-repository.js";
import { getAuditLogs } from "../repositories/audit-repository.js";
import { metrics } from "../services/metrics.js";

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export const reportController: FastifyPluginAsync = async (app) => {
  app.get("/metrics.csv", async (_req, reply) => {
    const snap = metrics.snapshot();
    const rows = [
      ["metric", "value"],
      ["uptime", snap.uptime],
      ["startedAt", snap.startedAt],
      ["totalRequests", snap.polling.totalRequests],
      ["successRate", snap.polling.successRate],
      ["latency_p95", snap.polling.latency.p95],
      ["changesDetected", snap.data.changesDetected],
      ["tripsInserted", snap.data.tripsInserted],
      ["tripsSkipped", snap.data.tripsSkipped],
    ];

    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="spx-metrics.csv"')
      .send(rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
  });

  app.get("/history.csv", async (_req, reply) => {
    const rows = await getBookingHistory(1000);
    const header = ["request_id", "booking_id", "origin", "destination", "vehicle_type", "standby_datetime", "created_at"];
    const body = rows.map((row) => [
      row.requestId,
      row.bookingId,
      row.origin,
      row.destination,
      row.vehicleType,
      row.standbyDateTime,
      row.createdAt,
    ]);

    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="spx-history.csv"')
      .send([header, ...body].map((row) => row.map(csvEscape).join(",")).join("\n"));
  });

  app.get("/audit.csv", async (_req, reply) => {
    const rows = await getAuditLogs(1000);
    const header = ["id", "username", "action", "details", "created_at"];
    const body = rows.map((row) => [row.id, row.username, row.action, row.details, row.createdAt]);

    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="spx-audit.csv"')
      .send([header, ...body].map((row) => row.map(csvEscape).join(",")).join("\n"));
  });
};
