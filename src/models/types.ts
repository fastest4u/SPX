// API Request
export interface BiddingRequest {
  pageno: number;
  count: number;
  request_tab_pending_confirmation: boolean;
  request_ctime_start: number;
}

export interface BookingRequestListRequest {
  request_tab_pending_confirmation: boolean;
  booking_id: number;
  pageno: number;
  count: number;
}

// API Response
export interface ApiResponse {
  retcode: number;
  message: string;
  data: BookingListData;
}

export interface BookingListData {
  pageno: number;
  count: number;
  total: number;
  list: Booking[];
}

export interface Booking {
  booking_name: string;
  function: number;
  booking_id: number;
  parent_booking_id: number;
  agency_id: number;
  agency_name: string;
  trip_type: number;
  cost_type: number;
  shift_type: number;
  ctime: number; // unix timestamp
  mtime: number; // unix timestamp
  recurring_booking: number;
  repeat_type: number;
  repeat_weekly: unknown | null;
  repeat_monthly: unknown | null;
  time_status: number;
  fulfilled_status: number;
  booking_period_start: number;
  booking_period_end: number;
  booking_date: number;
  operator: string; // email
  cancel_able: number; // 0 or 1
  edit_able: number; // 0 or 1
  recreate_able: number; // 0 or 1
  booking_tiering_type: number;
  sync_to_agency_portal: number;
  bidding_ddl: number; // unix timestamp
  assign_logic: number;
  award_logic: number;
  tier_per_round: number;
  time_per_round: number;
  request_acceptance_status: number;
  request_assignment_status: number;
  display_countdown_accept: number;
  ticket_id: string;
  ticket_status: number;
  adhoc_tag: number;
  cancel_label: number;
}

// HTTP Headers
export interface ApiHeaders {
  accept: string;
  "accept-language": string;
  app: string;
  "content-type": string;
  "device-id": string;
  priority: string;
  "sec-ch-ua": string;
  "sec-ch-ua-mobile": string;
  "sec-ch-ua-platform": string;
  "sec-fetch-dest": string;
  "sec-fetch-mode": string;
  "sec-fetch-site": string;
  cookie: string;
  Referer: string;
}

// Polling result
interface PollingResultBase {
  latencyMs: number;
  httpStatus: number;
  timestamp: Date;
  requestNumber: number;
}

export interface PollingSuccessResult extends PollingResultBase {
  success: true;
  data: ApiResponse;
}

export interface PollingFailureResult extends PollingResultBase {
  success: false;
  error: string;
}

export type PollingResult = PollingSuccessResult | PollingFailureResult;

// Data change detection
export interface DataChange {
  hasChanged: boolean;
  isFirst: boolean;
  hash: number;
  recordCount: number | null;
}

// Statistics
export interface PollingStats {
  totalRequests: number;
  errorCount: number;
  startTime: Date;
}

// ---- Booking Overview (Detail) ----
export interface BookingOverviewResponse {
  retcode: number;
  message: string;
  data: BookingOverview;
}

export interface BookingRequestListResponse {
  retcode: number;
  message: string;
  data: BookingRequestListData;
}

export interface BookingRequestListData {
  pageno: number;
  count: number;
  total: number;
  request_list: BookingRequestListItem[];
}

export interface BookingOverview {
  id: number;
  booking_name: string;
  function: number;
  agency_id: number;
  agency_name: string;
  cost_type: number;
  trip_type: number;
  shift_type: number;
  operator: string;
  recurring_booking: number;
  parent_booking_id: number;
  booking_date: number;
  booking_period_start: number;
  booking_period_end: number;
  repeat_type: number;
  repeat_weekly: unknown | null;
  repeat_monthly: unknown | null;
  time_status: number;
  fulfilled_status: number;
  ctime: number;
  mtime: number;
  vehicle_driver_info: VehicleDriverInfo[];
  booking_tiering_type: number;
  sync_to_agency_portal: number;
  bidding_ddl: number;
  assign_logic: number;
  award_logic: number;
  tier_per_round: number;
  time_per_round: number;
  request_acceptance_status: number;
  request_assignment_status: number;
  ticket_id: string;
  ticket_status: number;
  adhoc_tag: number;
  adhoc_reason_id: number;
  adhoc_reason_message: string;
  booking_period_edit_flag: boolean;
  is_parent_sync_agency_portal: boolean;
}

export interface VehicleDriverInfo {
  reporting_station_id: number;
  reporting_station_name: string;
  trip_path: unknown[];
  standby_time: number;
  vehicle_type: number;
  vehicle_type_name: string;
  vehicle_plate_number: string;
  vehicle_quantity: number;
  driver_id: number;
  driver_name: string;
  driver_contact_number: string;
  onsite_registration_ids: string;
  replacement_vehicle_plate_number: string;
  route_level: number;
  route_path: unknown | null;
  cost_type: number;
  trip_type: number;
  shift_type: number;
  agency_id: number;
  agency_name: string;
  request_acceptance_status: number;
  request_assignment_status: number;
  fulfilled_status: number;
  request_id: number;
  reject_reason_type: number;
  driver_arrive_time: number;
  registration_time: number;
  route_detail_list: RouteDetail[];
  trip_limit: number;
  origin_driver_id: number;
  origin_driver_name: string;
  replacement_vehicle_type: number;
  replacement_vehicle_type_name: string;
  right_vehicle_type: number;
  right_vehicle_type_name: string;
}

export interface BookingRequestListItem {
  onsite_id: number;
  request_id: number;
  booking_id: number;
  booking_date: number;
  report_station_id: number;
  report_station_name: string;
  cost_type: number;
  shift_type: number;
  trip_type: number;
  trip_path: unknown | null;
  route_path: unknown | null;
  route_level: number;
  vehicle_type: number;
  vehicle_type_name: string;
  vehicle_plate_number: string;
  driver_id: number;
  driver_name: string;
  driver_contact_number: string;
  standby_time: number;
  remark: string;
  request_acceptance_status: number;
  request_assignment_status: number;
  request_fulfilled_status: number;
  request_assign_ddl: number;
  assign_able: number;
  display_countdown_assign: number;
  child_request_edit: boolean;
  request_mtime: number;
  route_detail_list: RouteDetail[];
  trip_limit: number;
  partially_canceled: boolean;
  origin_driver_id: number;
  origin_driver_name: string;
  right_vehicle_type: number;
  right_vehicle_type_name: string;
  replacement_vehicle_type: number;
  replacement_vehicle_type_name: string;
  replacement_vehicle_plate_number: string;
}

export interface RouteDetail {
  route_level: number;
  node_id: number;
  station_type_list: unknown[];
  station_type_name_list: unknown | null;
  node_info_list: NodeInfo[];
}

export interface NodeInfo {
  id: number;
  name: string;
  address_info: AddressInfo;
}

export interface AddressInfo {
  l1: string; // province
  l2: string; // postcode
}

// Status enums for UI
export type BookingStatusCode =
  | 1 // pending
  | 2 // active
  | 3; // completed

export type AcceptanceStatus =
  | 1 // waiting
  | 2 // accepted
  | 3; // rejected
