import { env } from "../config/env.js";
import { listRuntimeNodes, listTeamRuntimeLeases } from "../repositories/runtime-repository.js";
import { getNotificationQueueSummary, listProviderDeliveryReadModelRows } from "../repositories/notification-repository.js";
import { getLineImageExtractionSummary } from "../repositories/line-image-extraction-repository.js";
import { getAutoAcceptJobQueueSummary } from "../repositories/auto-accept-job-repository.js";
import { loadRuntimeStatusReadModel } from "./runtime-status-read-model.js";
import { collectConfiguredDownstreamHealth } from "./service-health.js";
import type { RealtimeScope } from "./realtime-contract.js";

export function loadConfiguredRuntimeStatus(scope: RealtimeScope) {
  return loadRuntimeStatusReadModel({
    scope,
    dependencies: {
      listNodes: listRuntimeNodes,
      listLeases: listTeamRuntimeLeases,
      getNotifications: getNotificationQueueSummary,
      getProviderDeliveryRows: listProviderDeliveryReadModelRows,
      getOcrSummary: getLineImageExtractionSummary,
      getAutoAcceptJobSummary: getAutoAcceptJobQueueSummary,
      collectServiceHealth: (generatedAt) => collectConfiguredDownstreamHealth({
        checkedAt: generatedAt,
        role: env.SPX_ROLE,
        nodeId: env.SPX_NODE_ID || env.SPX_ROLE,
        lineServiceUrl: env.LINE_SERVICE_URL,
        lineServiceRequestTimeoutMs: env.LINE_SERVICE_REQUEST_TIMEOUT_MS,
        ocrServiceUrl: env.OCR_SERVICE_URL,
        ocrServiceRequestTimeoutMs: env.OCR_SERVICE_REQUEST_TIMEOUT_MS,
      }),
    },
  });
}
