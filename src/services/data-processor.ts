import { hashString } from "../utils/hash.js";
import type { DataChange, ApiResponse, Booking } from "../models/types.js";

export class DataProcessor {
  private lastHash: number | null = null;

  detectChange(data: ApiResponse): DataChange {
    const list = data.data?.list ?? [];
    // Stable compact projection: only identity + status fields that signal a
    // meaningful change, so volatile/reordered payload fields don't cause false
    // positives and birthday-collision risk over full JSON is avoided.
    const projection =
      `${list.length}|` +
      list
        .map(
          (b) =>
            `${b?.booking_id ?? ""}:${b?.request_acceptance_status ?? ""}:${b?.request_assignment_status ?? ""}`,
        )
        .join("|");
    const currentHash = hashString(projection);
    const recordCount = data.data?.list?.length ?? null;
    const isFirst = this.lastHash === null;
    const hasChanged = !isFirst && currentHash !== this.lastHash;

    this.lastHash = currentHash;

    return {
      hasChanged,
      isFirst,
      hash: currentHash,
      recordCount,
    };
  }

  extractSummary(data: ApiResponse): Record<string, unknown> | null {
    const list = data.data?.list ?? [];

    if (list.length > 0) {
      const first: Booking = list[0];
      return {
        total: data.data.total,
        returned: list.length,
        firstBookingId: first.booking_id,
        firstBookingName: first.booking_name,
        operator: first.operator,
        acceptanceStatus: first.request_acceptance_status,
        assignmentStatus: first.request_assignment_status,
      };
    }
    return {
      total: data.data?.total ?? 0,
      returned: 0,
    };
  }
}
