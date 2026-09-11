export type ProviderAuthState = "manual" | "connected" | "connecting" | "attention" | "retry_wait";

export type ProviderAuthErrorCode =
  | "invalid_credentials"
  | "challenge_required"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_response"
  | "invalid_input"
  | "session_expired"
  | "busy"
  | "not_configured"
  | "stale_operation";

export interface ProviderCredentials {
  email: string;
  password: string;
}

export interface ProviderSession {
  cookie: string;
  deviceId: string;
  expiresAt: string | null;
}

export interface ProviderAuthStatus {
  teamId: number;
  email: string;
  hasPassword: boolean;
  status: ProviderAuthState;
  lastLoginAt: string | null;
  expiresAt: string | null;
  errorCode: ProviderAuthErrorCode | null;
  retryAt: string | null;
}

export interface ProviderAuthRecord extends ProviderAuthStatus {
  /** Durable database state, unaffected by the public `connecting` lease projection. */
  storedStatus: ProviderAuthState;
  password: string;
  cookie: string;
  deviceId: string;
  epoch: number;
  failures: number;
  enabled: boolean;
}

export interface ProviderAuthLease {
  teamId: number;
  token: string;
  epoch: number;
}
