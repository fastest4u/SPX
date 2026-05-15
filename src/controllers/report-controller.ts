import { Readable } from "node:stream";
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

function csvLine(row: unknown[]): string {
  return row.map(csvEscape).join(",");
}

function csvStream(rows: Iterable<unknown[]>): Readable {
  function* lines(): Generator<string> {
    let first = true;
    for (const row of rows) {
      yield `${first ? "" : "\n"}${csvLine(row)}`;
      first = false;
    }
  }

  return Readable.from(lines());
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
      ["detail_fetch_p95", snap.operations.detailFetch.p95],
      ["db_save_p95", snap.operations.dbSave.p95],
      ["notify_p95", snap.operations.notify.p95],
      ["auto_accept_p95", snap.operations.autoAccept.p95],
      ["active_detail_jobs", snap.runtime.activeDetailJobs],
      ["active_detail_bookings", snap.runtime.activeDetailBookings],
      ["queued_detail_bookings", snap.runtime.queuedDetailBookings],
      ["detail_queue_pressure", snap.runtime.detailQueuePressure],
      ["sse_clients", snap.runtime.sseClients],
      ["changesDetected", snap.data.changesDetected],
      ["tripsInserted", snap.data.tripsInserted],
      ["tripsSkipped", snap.data.tripsSkipped],
    ];

    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="spx-metrics.csv"')
      .send(csvStream(rows));
  });

  app.get("/history.csv", async (_req, reply) => {
    const rows = await getBookingHistory(1000);
    const header = ["request_id", "booking_id", "origin", "destination", "vehicle_type", "standby_datetime", "created_at"];
    function* body(): Generator<unknown[]> {
      yield header;
      for (const row of rows) {
        yield [
          row.requestId,
          row.bookingId,
          row.origin,
          row.destination,
          row.vehicleType,
          row.standbyDateTime,
          row.createdAt,
        ];
      }
    }

    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="spx-history.csv"')
      .send(csvStream(body()));
  });

  app.get("/audit.csv", async (_req, reply) => {
    const rows = await getAuditLogs(1000);
    const header = ["id", "username", "action", "details", "created_at"];
    function* body(): Generator<unknown[]> {
      yield header;
      for (const row of rows) {
        yield [row.id, row.username, row.action, row.details, row.createdAt];
      }
    }

    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="spx-audit.csv"')
      .send(csvStream(body()));
  });
};
