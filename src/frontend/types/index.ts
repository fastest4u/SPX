// Standard API Response Types
export interface ApiSuccessResponse<T> {
  status: 'success';
  message?: string;
  data: T;
}

export interface ApiErrorResponse {
  status: 'error';
  error_code: string;
  message: string;
  details?: unknown;
}

export interface PaginationMeta {
  current_page: number;
  per_page: number;
  total_items: number;
  total_pages: number;
}

export interface ApiPaginatedResponse<T> {
  status: 'success';
  message?: string;
  data: T[];
  meta: PaginationMeta;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// Auth Types
export interface AuthUser {
  id: number;
  username: string;
  role: 'user' | 'admin';
  teamId: number | null;
  teamName?: string | null;
}

export interface LoginResponse {
  status: 'success';
  message?: string;
  data: AuthUser;
}

export interface MeResponse {
  status: 'success';
  message?: string;
  data: AuthUser;
}

// Rule Types
export interface NotifyRule {
  id: string;
  teamId?: number;
  teamName?: string;
  name: string;
  origins: string[];
  destinations: string[];
  vehicle_types: string[];
  need: number;
  enabled: boolean;
  fulfilled: boolean;
  /** Always true for enabled rules. Field kept for wire compatibility. */
  auto_accept: boolean;
  accept_all: boolean;
  auto_accepted: boolean;
}

export interface RuleInput {
  teamId?: number;
  name: string;
  origins: string[];
  destinations: string[];
  vehicle_types: string[];
  need: number;
  enabled?: boolean;
  accept_all?: boolean;
}

export interface RulePatch {
  teamId?: number;
  name?: string;
  origins?: string[];
  destinations?: string[];
  vehicle_types?: string[];
  need?: number;
  enabled?: boolean;
  fulfilled?: boolean;
  accept_all?: boolean;
  auto_accepted?: boolean;
}

export interface RulePreviewMatch {
  origin?: string;
  destination?: string;
  vehicle_type?: string;
  request_id?: number;
  booking_id?: number | null;
  standby_datetime?: string | null;
  created_at?: string;
}

export interface RulePreviewResult {
  ruleId: string;
  ruleName: string;
  matchedCount: number;
  need: number;
  acceptAll: boolean;
  sampleSize: number;
  scannedCount: number;
  wouldMatch: boolean;
  trips: RulePreviewMatch[];
}

// History/Booking Types
export interface BookingHistory {
  id: number;
  teamId?: number;
  teamName?: string | null;
  requestId: number;
  bookingId: number;
  bookingName?: string;
  agencyName?: string;
  route?: string;
  origin: string;
  destination: string;
  vehicleType: string;
  standbyDateTime: string;
  acceptanceStatus?: string;
  assignmentStatus?: string;
  createdAt: string;
}

export interface HistoryFilterQuery {
  search?: string;
  requestId?: number;
  bookingId?: number;
  origin?: string;
  destination?: string;
  vehicleType?: string;
  sortBy?: 'created_at' | 'request_id';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  page?: number;
  pageSize?: number;
}

export interface PaginatedHistory {
  status: 'success';
  message?: string;
  data: BookingHistory[];
  meta: PaginationMeta;
}

export interface LineImageExtraction {
  id: number;
  chatId: string;
  senderId: string;
  imagePath: string;
  imageUrl: string;
  dateText: string;
  tripNumber: string;
  driverName: string;
  agencyName: string;
  vehicleType: string;
  route: string;
  rawText: string;
  createdAt: string;
}

export interface LineImageExtractionQuery {
  search?: string;
  agency?: string;
  tripNumber?: string;
  route?: string;
  vehicleType?: string;
  driver?: string;
  createdFrom?: string;
  createdTo?: string;
  month?: string;
  sortBy?: 'created_at' | 'date_text' | 'trip_number' | 'driver_name' | 'route';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

// Audit Types
export interface AuditLog {
  id: number;
  username: string;
  action: string;
  details?: string;
  createdAt: string;
}

export interface AuditQuery {
  limit?: number;
  search?: string;
  username?: string;
  action?: string;
  sortBy?: 'created_at' | 'id';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

// User Types
export interface User {
  id: number;
  username: string;
  role: 'user' | 'admin';
  teamId: number | null;
  teamName?: string | null;
  createdAt: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role?: 'user' | 'admin';
  teamId?: number | null;
}

export interface PasswordInput {
  password: string;
}

export interface RoleInput {
  role: 'user' | 'admin';
  teamId?: number | null;
}

export interface Team {
  id: number;
  name: string;
  enabled: boolean;
  hasSpxCookie: boolean;
  hasSpxDeviceId: boolean;
  hasLineGroupId: boolean;
  spxCookiePreview: string;
  spxDeviceIdPreview: string;
  lineGroupIdPreview: string;
  runtimeStatus?: 'stopped' | 'running' | 'paused' | 'misconfigured' | 'session_expired' | 'error';
  usersCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamInput {
  name: string;
  enabled?: boolean;
  spxCookie?: string;
  spxDeviceId?: string;
  lineGroupId?: string;
}

// Settings Types
export interface EnvSettings {
  API_URL?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINEJS_TEST_ENABLED?: string;
  LINEJS_TEST_TARGET_ID?: string;
  LINEJS_TEST_DEVICE?: string;
  LINEJS_TEST_STORAGE_PATH?: string;
  DISCORD_WEBHOOK_URL?: string;
  POLL_INTERVAL_MS?: string;
  BOOKING_DETAIL_CONCURRENCY?: string;
  BOOKING_REPROCESS_COOLDOWN_MS?: string;
  BIDDING_VEHICLE_TYPE?: string;
  CODEX_IMAGE_PROVIDER?: string;
}

export interface CodexDeviceAuthStatus {
  authenticated: boolean;
  hasPendingFlow: boolean;
  hasPendingDeviceCode: boolean;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  accountIdSuffix?: string;
  authPath?: string;
}

export interface CodexDeviceAuthStart {
  mode: 'browser' | 'device';
  authorizationUrl?: string;
  state?: string;
  redirectUri?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
}

export interface CodexDeviceAuthComplete {
  authenticated: true;
  expiresAt: number;
}

// Line Quota
export interface LineQuota {
  enabled: boolean;
  totalUsage: number;
  limit: number;
  type: string;
}

// Metrics Types
export type TimedOperation =
  | 'detailFetch'
  | 'dbSave'
  | 'notify'
  | 'autoAccept'
  | 'acceptRtt'
  | 'detailToFirstMatch'
  | 'autoAcceptVerify'
  | 'acceptToVerify'
  | 'listAgeMs'

export interface TimingSummary {
  count: number
  avg: number
  min: number
  max: number
  p50: number
  p95: number
  p99: number
  lastMs: number | null
}

export interface RuntimeMetrics {
  activeDetailJobs: number
  activeDetailBookings: number
  detailConcurrency: number
  queuedDetailBookings: number
  detailQueuePressure: number
  sseClients: number
}

export interface AutoAcceptVerificationMetrics {
  queued: number
  active: number
  completed: number
  indeterminate: number
  maxQueueDepth: number
  failuresByReason: Record<string, number>
}

export interface PoolStats {
  totalConnections: number
  idleConnections: number
  acquiredConnections: number
  queuedRequests: number
  connectionLimit: number
}

export interface MetricsSnapshot {
  teamId: number | null;
  teamName?: string;
  isPaused?: boolean;
  uptime: number;
  startedAt: string;
  lastPoll: {
    timestamp: string | null;
    status: string | null;
    latencyMs: number | null;
    recordCount: number | null;
  };
  polling: {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    successRate: number;
    latency: {
      avg: number;
      min: number;
      max: number;
      p50: number;
      p95: number;
      p99: number;
    };
  };
  session: {
    isHealthy: boolean;
    consecutiveErrors: number;
    lastSessionWarning: string | null;
  };
  database: PoolStats | null;
  data: {
    totalRecordsSeen: number;
    changesDetected: number;
    tripsInserted: number;
    tripsSkipped: number;
  };
  autoAccept: {
    totalAttempts: number;
    successCount: number;
    failureCount: number;
    verifiedSuccessCount?: number;
    verifiedFailureCount?: number;
    pendingVerificationCount?: number;
    verification?: AutoAcceptVerificationMetrics;
  };
  scheduling?: {
    launched: number;
    skippedConcurrency: number;
    skippedCooldown: number;
  };
  upstream?: {
    requests: number;
    connections: number;
    reuseRatio: number;
  };
  operations: Record<TimedOperation, TimingSummary>;
  runtime: RuntimeMetrics;
}

export interface MetricsHistoryRow {
  id: number;
  teamId?: number;
  createdAt: string;
  successRate: number;
  latencyAvg: number;
  latencyP95: number;
  requestCount: number;
}

// Health/Ready Types
export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime: number;
  startedAt: string;
  lastPoll: string;
  errorRate: number;
  session: {
    healthy: boolean;
    consecutiveErrors: number;
    lastSessionWarning: string | null;
  };
  database: PoolStats | null;
  autoAccept: {
    totalAttempts: number;
    successCount: number;
    failureCount: number;
  };
}

export interface ReadyResponse {
  ready: boolean;
  checks: Record<string, string>;
  poolStats?: {
    connectionLimit: number;
    acquiredConnections: number;
    queuedRequests: number;
  };
}

// Bidding Types
export interface AcceptBookingInput {
  teamId?: number;
  bookingId: number;
  requestIds: number[];
  confirm: true;
}

export interface AcceptAllBookingInput {
  teamId: number;
  bookingId: number;
  confirm: true;
}

export interface AcceptBookingResponse {
  ok: boolean;
  bookingId?: number;
  requestIds?: number[];
  response?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface AcceptAllBookingResponse {
  bookingId: number;
  teamId: number;
  acceptAll: true;
  acceptedCount?: number;
  requestIds?: number[];
  notified?: boolean;
  response?: unknown;
}

// Notification Types
export interface NotificationPreview {
  ok: boolean;
  preview: {
    title: string;
    message: string;
    channels: {
      line: boolean;
      discord: boolean;
      linejs_test: boolean;
    };
  };
}

export interface NotificationTestResult {
  ok: boolean;
  sent: {
    line: boolean;
    discord: boolean;
    linejs_test: boolean;
  };
  channels: Array<{
    channel: string;
    ok: boolean;
    error?: string;
    qrUrl?: string;
    pincode?: string;
  }>;
  message: string;
}

// API Error
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// Auto-Accept History Types
export interface AutoAcceptHistoryItem {
  id: number;
  teamId: number;
  teamName?: string | null;
  ruleId: string;
  ruleName: string;
  bookingId: number;
  requestIds: number[];
  acceptedCount: number;
  origin: string;
  destination: string;
  vehicleType: string;
  status: 'success' | 'failed' | 'indeterminate';
  errorMessage?: string;
  failureReason?: string | null;
  traceId?: string | null;
  acceptRttMs?: number | null;
  listAgeMs?: number | null;
  verificationLatencyMs?: number | null;
  verificationStatus?: string | null;
  verifiedAt?: string | null;
  createdAt: string;
}

export interface AutoAcceptHistoryQuery {
  limit?: number;
  search?: string;
  ruleName?: string;
  status?: string;
  sortBy?: 'created_at' | 'id';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

// LINE Bot Types
export interface LineBotStatus {
  enabled: boolean;
  authenticated: boolean;
  qrUrl?: string;
  pincode?: string;
  message: string;
}

export interface LineBotChat {
  chatMid: string;
  chatName: string;
}

export interface LineBotGroupList {
  chats: LineBotChat[];
}

export interface LineBotSendInput {
  to: string;
  text: string;
}

export interface LineBotSendResult {
  sent: boolean;
}
