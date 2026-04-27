import type { BookingOverview, BookingRequestListData, RouteDetail, VehicleDriverInfo } from "../models/types.js";

// Mappings
const COST_TYPE_MAP: Record<number, string> = {
  0: "-",
  1: "Fixed",
  2: "By Hour",
  3: "By Weight",
  4: "By Distance",
  5: "By Distance", // จากข้อมูลจริง
};

const TRIP_TYPE_MAP: Record<number, string> = {
  0: "-",
  1: "Round Trip",
  2: "One Way",
};

const SHIFT_TYPE_MAP: Record<number, string> = {
  0: "By Land", // จากข้อมูลจริง
  1: "Day Shift",
  2: "Night Shift",
};

function formatDate(unixTimestamp: number): string {
  const date = new Date(unixTimestamp * 1000);
  return date.toLocaleDateString("th-TH", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export interface ExtractedTripInfo {
  เส้นทาง: string;
  ประเภทการจ่าย: string;
  รูปแบบของทริป: string;
  ประเภทการเดินทาง: string;
  ประเภทรถ: string;
  ต้นทาง: string;
  ปลายทาง: string;
  วันที่เวลาสแตนบาย: string;
  request_id: number;
  booking_id?: number;
  booking_name?: string;
  agency_name?: string;
  acceptance_status?: number;
  assignment_status?: number;
}

interface TripInfoSource {
  booking_date: number;
  request_id: number;
  route_detail_list: RouteDetail[];
  standby_time: number;
  cost_type: number;
  trip_type: number;
  shift_type: number;
  vehicle_type_name: string;
  booking_id?: number;
  booking_name?: string;
  agency_name?: string;
  request_acceptance_status?: number;
  request_assignment_status?: number;
}

function extractTripInfoFromSource(source: TripInfoSource): ExtractedTripInfo {
  const routeList = source.route_detail_list || [];
  const origin = routeList[0]?.node_info_list?.[0]?.name || "-";
  const destination = routeList[routeList.length - 1]?.node_info_list?.[0]?.name || "-";

  const standbyDateTime = source.booking_date
    ? formatDate(source.booking_date) + " " + minutesToTime(source.standby_time || 0)
    : "-";

  return {
    เส้นทาง: `${origin} -> ${destination}`,
    ประเภทการจ่าย: COST_TYPE_MAP[source.cost_type] || "-",
    รูปแบบของทริป: TRIP_TYPE_MAP[source.trip_type] || "-",
    ประเภทการเดินทาง: SHIFT_TYPE_MAP[source.shift_type] || "-",
    ประเภทรถ: source.vehicle_type_name || "-",
    ต้นทาง: origin,
    ปลายทาง: destination,
    วันที่เวลาสแตนบาย: standbyDateTime,
    request_id: source.request_id,
    booking_id: source.booking_id,
    booking_name: source.booking_name,
    agency_name: source.agency_name,
    acceptance_status: source.request_acceptance_status,
    assignment_status: source.request_assignment_status,
  };
}

export function extractTripInfo(
  overview: BookingOverview,
  vehicleInfo: VehicleDriverInfo
): ExtractedTripInfo {
  return extractTripInfoFromSource({
    ...vehicleInfo,
    booking_date: overview.booking_date,
  });
}

export function extractAllTrips(overview: BookingOverview): ExtractedTripInfo[] {
  return overview.vehicle_driver_info.map((v) => extractTripInfo(overview, v));
}

export interface BookingContext {
  booking_id: number;
  booking_name: string;
  agency_name: string;
}

export function extractAllRequestListTrips(
  data: BookingRequestListData,
  context?: BookingContext
): ExtractedTripInfo[] {
  return data.request_list.map((request) =>
    extractTripInfoFromSource({
      ...request,
      booking_id: context?.booking_id,
      booking_name: context?.booking_name,
      agency_name: context?.agency_name,
    })
  );
}

// Format for display
export function formatTripInfo(trip: ExtractedTripInfo): string {
  return `
เส้นทาง: ${trip.เส้นทาง}
request_id: ${trip.request_id}
ประเภทการจ่าย: ${trip.ประเภทการจ่าย}
รูปแบบของทริป: ${trip.รูปแบบของทริป}
ประเภทการเดินทาง: ${trip.ประเภทการเดินทาง}
ประเภทรถ: ${trip.ประเภทรถ}
ต้นทาง: ${trip.ต้นทาง}
ปลายทาง: ${trip.ปลายทาง}
วันที่/เวลาสแตนบาย: ${trip.วันที่เวลาสแตนบาย}
-------------------
`.trim();
}
