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
}

export interface LoginResponse {
  status: 'success';
  message?: string;
  data: { token: string } | null;
}

export interface MeResponse {
  status: 'success';
  message?: string;
  data: AuthUser;
}

// Rule Types
export interface NotifyRule {
  id: string;
  name: string;
  origins: string[];
  destinations: string[];
  vehicle_types: string[];
  need: number;
  enabled: boolean;
  fulfilled: boolean;
  auto_accept: boolean;
  auto_accepted: boolean;
}

export interface RuleInput {
  name: string;
  origins: string[];
  destinations: string[];
  vehicle_types: string[];
  need: number;
  enabled?: boolean;
  auto_accept?: boolean;
}

export interface RulePatch {
  name?: string;
  origins?: string[];
  destinations?: string[];
  vehicle_types?: string[];
  need?: number;
  enabled?: boolean;
  fulfilled?: boolean;
  auto_accept?: boolean;
}

// History/Booking Types
export interface BookingHistory {
  id: number;
  requestId: number;
  bookingId: number;
  bookingName?: string;
  agencyName?: string;
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
}

// User Types
export interface User {
  id: number;
  username: string;
  role: 'user' | 'admin';
  createdAt: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role?: 'user' | 'admin';
}

export interface PasswordInput {
  password: string;
}

export interface RoleInput {
  role: 'user' | 'admin';
}

// Settings Types
export interface EnvSettings {
  API_URL?: string;
  COOKIE?: string;
  DEVICE_ID?: string;
  LINE_NOTIFY_TOKEN?: string;
  DISCORD_WEBHOOK_URL?: string;
  POLL_INTERVAL_MS?: string;
}

// Metrics Types
export interface MetricsSnapshot {
  uptime: number;
  startedAt: string;
  lastPoll: {
    timestamp: string;
    status: string;
    latencyMs: number;
  };
  polling: {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    successRate: number;
    latency: {
      avg: number;
      p95: number;
    };
  };
  session: {
    isHealthy: boolean;
    consecutiveErrors: number;
    lastSessionWarning?: string;
  };
  database: {
    poolSize: number;
    acquiredConnections: number;
    pendingConnections: number;
  };
  data: {
    changesDetected: number;
    tripsInserted: number;
    tripsSkipped: number;
  };
  autoAccept: {
    enabled: boolean;
    acceptedCount: number;
    lastAcceptedAt?: string;
  };
}

export interface MetricsHistoryRow {
  id: number;
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
    lastSessionWarning?: string;
  };
  database: {
    poolSize: number;
    acquiredConnections: number;
    pendingConnections: number;
  };
  autoAccept: {
    enabled: boolean;
    acceptedCount: number;
    lastAcceptedAt?: string;
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
  bookingId: number;
  requestIds: number[];
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

// Notification Types
export interface NotificationPreview {
  ok: boolean;
  preview: {
    title: string;
    message: string;
    channels: {
      line: boolean;
      discord: boolean;
    };
  };
}

export interface NotificationTestResult {
  ok: boolean;
  sent: {
    line: boolean;
    discord: boolean;
  };
  channels: Array<{
    channel: string;
    ok: boolean;
    error?: string;
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
