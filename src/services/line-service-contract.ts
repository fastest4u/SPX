export const LINE_INTERNAL_SEND_PATH = "/internal/line/messages";
export const LINE_INTERNAL_STATUS_PATH = "/internal/line/status";
export const LINE_INTERNAL_LOGIN_PATH = "/internal/line/login";
export const LINE_INTERNAL_GROUPS_PATH = "/internal/line/groups";
export const LINE_INTERNAL_PROFILE_PATH = "/internal/line/profile";
export const LINE_INTERNAL_STORAGE_PATH = "/internal/line/storage";
export const LINE_INTERNAL_LOGOUT_PATH = "/internal/line/logout";

export interface LineServiceSendRequest {
  targetId: string;
  text: string;
  traceId?: string;
  outboxId?: number;
}

export interface LineServiceSendResponse {
  sent: true;
  provider: "linejs";
  providerMessageId?: string;
}

export interface LineServiceStatusResponse {
  enabled: boolean;
  authenticated: boolean;
  qrUrl?: string;
  pincode?: string;
  listenerActive: boolean;
}

export interface LineServiceLoginResponse extends LineServiceStatusResponse {
  message: string;
}

export interface LineServiceGroupsResponse {
  chats: Array<{ chatMid: string; chatName: string }>;
}

export interface LineServiceProfileResponse {
  displayName: string;
  mid: string;
  statusMessage?: string;
  pictureUrl?: string;
}

export interface LineServiceStorageResponse {
  storagePath: string;
  exists: boolean;
  sizeBytes: number;
  hasE2EEKeys: boolean;
  hasAuthState: boolean;
}

export interface LineServiceLogoutRequest {
  clearStorage?: boolean;
}

export interface LineServiceLogoutResponse {
  loggedOut: true;
  clearStorage: boolean;
}
