import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { performance } from "node:perf_hooks";
import { env } from "../config/env.js";
import { getPool, getPoolStats } from "../db/client.js";
import { getNotificationQueueSummary } from "../repositories/notification-repository.js";
import {
  listRuntimeNodes,
  listTeamRuntimeLeases,
  listTeamRuntimeDesiredStates,
  setTeamRuntimeDesiredState,
} from "../repositories/runtime-repository.js";
import { listTeams } from "../repositories/team-repository.js";
import { insertAuditLog } from "../repositories/audit-repository.js";
import { collectConfiguredDownstreamHealth } from "../services/service-health.js";
import { projectPublicRuntimeStatusReadModel } from "../services/runtime-status-read-model.js";
import type { RealtimeReadGateway } from "../services/realtime-service-client.js";
import { sendSuccess, sendError } from "../utils/response.js";

export interface RuntimeStatusControllerOptions {
  realtimeReadGateway?: RealtimeReadGateway;
  loadLocalRuntimeStatus?: () => Promise<unknown>;
}

async function defaultLocalRuntimeStatus(): Promise<unknown> {
  const [nodes, leases, notifications, serviceHealth] = await Promise.all([
    listRuntimeNodes(),
    listTeamRuntimeLeases(),
    getNotificationQueueSummary(),
    collectConfiguredDownstreamHealth({
      role: env.SPX_ROLE,
      nodeId: env.SPX_NODE_ID || "web-api",
      lineServiceUrl: env.LINE_SERVICE_URL,
      lineServiceRequestTimeoutMs: env.LINE_SERVICE_REQUEST_TIMEOUT_MS,
      ocrServiceUrl: env.OCR_SERVICE_URL,
      ocrServiceRequestTimeoutMs: env.OCR_SERVICE_REQUEST_TIMEOUT_MS,
    }),
  ]);
  return { nodes, leases, notifications, serviceHealth };
}

export interface ServiceItem {
  id: string;
  name: string;
  category: "core" | "notification" | "poller" | "database" | "worker";
  host: string;
  role: string;
  port?: number | null;
  state: "ok" | "degraded" | "down";
  latencyMs: number | null;
  uptimeSeconds: number | null;
  nodeId: string;
  canRestart: boolean;
  canPing: boolean;
  summary: string;
  details: Record<string, unknown>;
}

export interface ServicesOverview {
  overallState: "ok" | "degraded" | "down";
  activeCount: number;
  totalCount: number;
  dbLatencyMs: number;
  serverUptimeSeconds: number;
  serverTimestamp: string;
}

export const runtimeStatusController: FastifyPluginAsync<RuntimeStatusControllerOptions> = async (app, options) => {
  /** Legacy raw status endpoint */
  app.get("/status", async (_request, reply) => {
    if (options.realtimeReadGateway) {
      try {
        const remote = await options.realtimeReadGateway.readRuntimeStatus({ scope: { kind: "admin" } });
        return sendSuccess(reply, projectPublicRuntimeStatusReadModel(remote));
      } catch {
        return sendError(reply, 503, "REALTIME_READ_UNAVAILABLE", "Realtime read service unavailable", { retryable: true });
      }
    }

    try {
      return sendSuccess(reply, await (options.loadLocalRuntimeStatus ?? defaultLocalRuntimeStatus)());
    } catch {
      return sendError(reply, 503, "REALTIME_READ_UNAVAILABLE", "Realtime read service unavailable", { retryable: true });
    }
  });

  /** GET /services — Consolidated Services Health & Status for UI */
  app.get("/services", async (_request: FastifyRequest, reply: FastifyReply) => {
    const serverTimestamp = new Date().toISOString();
    const serverUptimeSeconds = Math.floor(process.uptime());

    // 1. Probe Database
    const tDb = performance.now();
    let dbOk = false;
    let dbError: string | undefined;
    try {
      const pool = await getPool();
      if (!pool) {
        throw new Error("Database pool is not initialized");
      }
      await pool.query("SELECT 1");
      dbOk = true;
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error);
    }
    const dbLatencyMs = Math.round(performance.now() - tDb);

    // 2. Probe LINE Service
    let lineState: "ok" | "degraded" | "down" = "down";
    let lineLatencyMs: number | null = null;
    let lineDetails: Record<string, unknown> = {};
    if (env.LINE_SERVICE_URL) {
      const tLine = performance.now();
      try {
        const lineResp = await fetch(new URL("/ready", env.LINE_SERVICE_URL).toString(), {
          signal: AbortSignal.timeout(3000),
        });
        lineLatencyMs = Math.round(performance.now() - tLine);
        if (lineResp.ok) {
          const body = (await lineResp.json().catch(() => ({}))) as Record<string, unknown>;
          lineDetails = body;
          lineState = "ok";
        } else {
          lineState = "degraded";
          lineDetails = { status: lineResp.status };
        }
      } catch (error) {
        lineLatencyMs = Math.round(performance.now() - tLine);
        lineState = "down";
        lineDetails = { error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      lineState = "degraded";
      lineDetails = { message: "LINE_SERVICE_URL not configured" };
    }

    // 3. Load Pollers, Nodes, Leases, Teams
    const [teams, nodes, leases, desiredStates] = await Promise.all([
      listTeams().catch(() => []),
      listRuntimeNodes().catch(() => []),
      listTeamRuntimeLeases().catch(() => []),
      listTeamRuntimeDesiredStates().catch(() => []),
    ]);

    const services: ServiceItem[] = [
      {
        id: "web-api",
        name: "Primary Web API & Dashboard",
        category: "core",
        host: "45.83.207.139 (Primary)",
        role: env.SPX_ROLE || "notifier",
        port: Number(env.HTTP_PORT || 3000),
        state: "ok",
        latencyMs: 1,
        uptimeSeconds: serverUptimeSeconds,
        nodeId: env.SPX_NODE_ID || "web-api",
        canRestart: false,
        canPing: true,
        summary: "ศูนย์กลางควบคุม HTTP API, Dashboard SPA และระบบบริหารจัดการ",
        details: {
          nodeVersion: process.version,
          platform: process.platform,
          memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
      },
      {
        id: "mysql-db",
        name: "MySQL Database",
        category: "database",
        host: env.DB_HOST || "tms.pathwaylogistic.com",
        role: "database",
        port: Number(env.DB_PORT || 3306),
        state: dbOk ? "ok" : "down",
        latencyMs: dbLatencyMs,
        uptimeSeconds: null,
        nodeId: "mysql-production",
        canRestart: false,
        canPing: true,
        summary: dbOk ? "ฐานข้อมูลหลักพร้อมใช้งาน Connection Pool ปกติ" : `ฐานข้อมูลไม่พร้อมใช้งาน: ${dbError}`,
        details: {
          database: env.DB_NAME || "SPX",
          poolStats: getPoolStats(),
          error: dbError,
        },
      },
      {
        id: "line-service",
        name: "LINE Bot Service",
        category: "notification",
        host: "45.83.207.139 (Primary)",
        role: "line-service",
        port: 3003,
        state: lineState,
        latencyMs: lineLatencyMs,
        uptimeSeconds: null,
        nodeId: "prod-line-service-1",
        canRestart: false,
        canPing: true,
        summary:
          lineState === "ok"
            ? "บริการ LINE Bot เชื่อมต่อและพร้อมส่งข้อความแจ้งเตือน"
            : lineState === "degraded"
              ? "บริการ LINE Bot มีสถานะผิดปกติเล็กน้อย"
              : "บริการ LINE Bot ขาดการเชื่อมต่อหรือไม่ตอบสนอง",
        details: {
          url: env.LINE_SERVICE_URL,
          ...lineDetails,
        },
      },
    ];

    // Add poller teams
    for (const team of teams) {
      const lease = leases.find((l) => l.teamId === team.id);
      const node = lease ? nodes.find((n) => n.nodeId === lease.ownerNodeId) : undefined;
      const desired = desiredStates.find((d) => d.teamId === team.id)?.desiredState ?? (team.enabled ? "running" : "stopped");

      const isRunning = Boolean(lease && node);
      let pollerState: "ok" | "degraded" | "down" = "down";
      if (!team.enabled) {
        pollerState = "degraded";
      } else if (isRunning) {
        pollerState = "ok";
      }

      services.push({
        id: `team-${team.id}`,
        name: `Poller: ${team.name} (ทีม #${team.id})`,
        category: "poller",
        host: node?.hostname || (team.id === 2 ? "147.50.240.44 (Worker)" : "45.83.207.139 (Primary)"),
        role: "worker",
        port: null,
        state: pollerState,
        latencyMs: null,
        uptimeSeconds: null,
        nodeId: lease?.ownerNodeId || "unassigned",
        canRestart: true,
        canPing: true,
        summary: !team.enabled
          ? "ทีมนี้ปิดการใช้งานอยู่ (Disabled)"
          : isRunning
            ? `กำลังรัน Polling บน Node ${lease?.ownerNodeId}`
            : "รอกำหนดสิทธิ์ Node ทำงาน (Pending Lease)",
        details: {
          teamId: team.id,
          enabled: team.enabled,
          desiredState: desired,
          leaseToken: lease?.leaseToken ? `${lease.leaseToken.slice(0, 8)}...` : null,
          nodeMetadata: node?.metadataJson ? JSON.parse(node.metadataJson) : null,
        },
      });
    }

    const activeCount = services.filter((s) => s.state === "ok").length;
    const totalCount = services.length;
    const hasDown = services.some((s) => s.state === "down" && s.id !== "line-service");
    const hasDegraded = services.some((s) => s.state !== "ok");
    const overallState: "ok" | "degraded" | "down" = hasDown ? "down" : hasDegraded ? "degraded" : "ok";

    const overview: ServicesOverview = {
      overallState,
      activeCount,
      totalCount,
      dbLatencyMs,
      serverUptimeSeconds,
      serverTimestamp,
    };

    return sendSuccess(reply, { overview, services });
  });

  /** POST /services/diagnose — Run deep diagnostics across all infrastructure */
  app.post("/services/diagnose", async (_request: FastifyRequest, reply: FastifyReply) => {
    const timestamp = new Date().toISOString();
    const checks: Array<{
      id: string;
      name: string;
      target: string;
      state: "ok" | "degraded" | "down";
      latencyMs: number;
      message: string;
      recommendation?: string;
    }> = [];

    // 1. MySQL check
    const tDb = performance.now();
    try {
      const pool = await getPool();
      if (!pool) {
        throw new Error("Database pool is not initialized");
      }
      await pool.query("SELECT 1");
      const latencyMs = Math.round(performance.now() - tDb);
      checks.push({
        id: "mysql",
        name: "MySQL Query Handshake",
        target: env.DB_HOST || "tms.pathwaylogistic.com",
        state: latencyMs > 500 ? "degraded" : "ok",
        latencyMs,
        message: `เชื่อมต่อฐานข้อมูลและรันคิวรีสำเร็จ (${latencyMs} ms)`,
      });
    } catch (err) {
      const latencyMs = Math.round(performance.now() - tDb);
      checks.push({
        id: "mysql",
        name: "MySQL Query Handshake",
        target: env.DB_HOST || "tms.pathwaylogistic.com",
        state: "down",
        latencyMs,
        message: `เชื่อมต่อฐานข้อมูลล้มเหลว: ${err instanceof Error ? err.message : String(err)}`,
        recommendation: "ตรวจสอบการเชื่อมต่อเครือข่าย หรือรหัสผ่านฐานข้อมูลใน .env",
      });
    }

    // 2. LINE Service Health
    if (env.LINE_SERVICE_URL) {
      const tLine = performance.now();
      try {
        const res = await fetch(new URL("/health", env.LINE_SERVICE_URL).toString(), {
          signal: AbortSignal.timeout(3000),
        });
        const latencyMs = Math.round(performance.now() - tLine);
        if (res.ok) {
          checks.push({
            id: "line-health",
            name: "LINE Service /health Probe",
            target: env.LINE_SERVICE_URL,
            state: "ok",
            latencyMs,
            message: `Service ตอบกลับ HTTP ${res.status} ปกติ (${latencyMs} ms)`,
          });
        } else {
          checks.push({
            id: "line-health",
            name: "LINE Service /health Probe",
            target: env.LINE_SERVICE_URL,
            state: "degraded",
            latencyMs,
            message: `Service ตอบกลับ HTTP ${res.status}`,
            recommendation: "ตรวจสอบ container spx-line-service-1",
          });
        }
      } catch (err) {
        const latencyMs = Math.round(performance.now() - tLine);
        checks.push({
          id: "line-health",
          name: "LINE Service /health Probe",
          target: env.LINE_SERVICE_URL,
          state: "down",
          latencyMs,
          message: `ไม่สามารถเชื่อมต่อ LINE Service: ${err instanceof Error ? err.message : String(err)}`,
          recommendation: "ตรวจเช็กว่าคอนเทนเนอร์ spx-line-service-1 กำลังทำงานอยู่หรือไม่",
        });
      }

      // 3. LINE Service Ready & Bot Status
      const tReady = performance.now();
      try {
        const res = await fetch(new URL("/ready", env.LINE_SERVICE_URL).toString(), {
          signal: AbortSignal.timeout(3000),
        });
        const latencyMs = Math.round(performance.now() - tReady);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        checks.push({
          id: "line-ready",
          name: "LINE Bot Authentication & Webhook",
          target: `${env.LINE_SERVICE_URL}/ready`,
          state: res.ok ? "ok" : "degraded",
          latencyMs,
          message: res.ok
            ? "LINE Bot ยืนยันตัวตนสำเร็จและ Webhook Listener พร้อมทำงาน"
            : "LINE Bot ยังไม่พร้อมหรือต้องการการ Login ใหม่",
          recommendation: !res.ok ? "เข้าไปที่หน้า LINE Bot Settings เพื่อสแกน QR Code เข้าสู่ระบบ" : undefined,
        });
      } catch (err) {
        const latencyMs = Math.round(performance.now() - tReady);
        checks.push({
          id: "line-ready",
          name: "LINE Bot Authentication & Webhook",
          target: `${env.LINE_SERVICE_URL}/ready`,
          state: "down",
          latencyMs,
          message: `เช็กสถานะบอทล้มเหลว: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 4. Poller Heartbeats
    const tNodes = performance.now();
    try {
      const nodes = await listRuntimeNodes();
      const latencyMs = Math.round(performance.now() - tNodes);
      const now = Date.now();
      const activeNodes = nodes.filter((n) => {
        if (!n.lastHeartbeatAt) return false;
        const diff = now - new Date(n.lastHeartbeatAt).getTime();
        return diff < 60_000;
      });

      checks.push({
        id: "poller-nodes",
        name: "Poller Distributed Nodes Heartbeat",
        target: "runtime_nodes",
        state: activeNodes.length > 0 ? "ok" : "degraded",
        latencyMs,
        message: `พบ Node ที่มี Heartbeat สด ${activeNodes.length}/${nodes.length} nodes (${latencyMs} ms)`,
        recommendation: activeNodes.length === 0 ? "ตรวจสอบว่า Worker คอนเทนเนอร์ของแต่ละทีมกำลังรันอยู่" : undefined,
      });
    } catch (err) {
      checks.push({
        id: "poller-nodes",
        name: "Poller Distributed Nodes Heartbeat",
        target: "runtime_nodes",
        state: "down",
        latencyMs: Math.round(performance.now() - tNodes),
        message: `ตรวจ Node ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const overallOk = checks.every((c) => c.state === "ok");
    return sendSuccess(reply, { timestamp, overallOk, checks });
  });

  /** POST /services/:serviceId/action — Execute safe administrative action on service */
  app.post("/services/:serviceId/action", async (request: FastifyRequest<{ Params: { serviceId: string }; Body: { action: string; reason?: string } }>, reply: FastifyReply) => {
    const { serviceId } = request.params;
    const { action, reason } = request.body || {};
    const user = request.user as { id?: number; username?: string } | undefined;
    const username = user?.username || "admin";

    if (!action) {
      return sendError(reply, 400, "INVALID_ACTION", "action is required");
    }

    if (action === "ping") {
      if (serviceId === "mysql-db") {
        const t0 = performance.now();
        const pool = await getPool();
        if (!pool) {
          return sendError(reply, 503, "DB_UNAVAILABLE", "Database pool is not initialized");
        }
        await pool.query("SELECT 1");
        const latencyMs = Math.round(performance.now() - t0);
        return sendSuccess(reply, { serviceId, state: "ok", latencyMs, message: `Database responded in ${latencyMs} ms` });
      }

      if (serviceId === "line-service") {
        if (!env.LINE_SERVICE_URL) {
          return sendError(reply, 400, "NOT_CONFIGURED", "LINE_SERVICE_URL is not set");
        }
        const t0 = performance.now();
        const res = await fetch(new URL("/health", env.LINE_SERVICE_URL).toString(), { signal: AbortSignal.timeout(3000) });
        const latencyMs = Math.round(performance.now() - t0);
        return sendSuccess(reply, { serviceId, state: res.ok ? "ok" : "degraded", latencyMs, status: res.status });
      }

      if (serviceId.startsWith("team-")) {
        const teamId = Number(serviceId.replace("team-", ""));
        const leases = await listTeamRuntimeLeases();
        const lease = leases.find((l) => l.teamId === teamId);
        return sendSuccess(reply, {
          serviceId,
          state: lease ? "ok" : "degraded",
          lease: lease ? { nodeId: lease.ownerNodeId, expiresAt: lease.leaseExpiresAt.toISOString() } : null,
          message: lease ? `Team ${teamId} has active lease on ${lease.ownerNodeId}` : `No active lease for team ${teamId}`,
        });
      }

      return sendSuccess(reply, { serviceId, state: "ok", latencyMs: 1, message: "Service is responsive" });
    }

    if (action === "restart") {
      if (serviceId.startsWith("team-")) {
        const teamId = Number(serviceId.replace("team-", ""));
        if (!Number.isInteger(teamId) || teamId <= 0) {
          return sendError(reply, 400, "INVALID_TEAM_ID", "Invalid team ID");
        }

        await setTeamRuntimeDesiredState({
          teamId,
          desiredState: "restart",
          changedByUserId: user?.id ?? null,
          reason: reason || "User triggered service restart from services UI",
        });

        await insertAuditLog(username, "restart_team_poller", `Requested restart for Team ${teamId}`, {
          actorUserId: user?.id,
          targetTeamId: teamId,
        });

        return sendSuccess(reply, { serviceId, action: "restart", status: "scheduled", message: `รีสตาร์ท Poller ทีม #${teamId} แล้ว` });
      }

      await insertAuditLog(username, "restart_service_request", `Requested restart for service ${serviceId}`, {
        actorUserId: user?.id,
      });

      return sendSuccess(reply, {
        serviceId,
        action: "restart",
        status: "acknowledged",
        message: `ได้รับคำสั่งรีสตาร์ท ${serviceId} เรียบร้อย`,
      });
    }

    return sendError(reply, 400, "UNSUPPORTED_ACTION", `Action "${action}" is not supported`);
  });
};
