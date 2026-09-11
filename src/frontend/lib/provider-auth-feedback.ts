export function selectProviderAuthFeedbackCode({
  statusErrorCode,
  requestErrorCode,
  statusConfirmedAfterRequest,
}: {
  statusErrorCode: string | null | undefined
  requestErrorCode: string | null
  statusConfirmedAfterRequest: boolean
}): string | null {
  if (requestErrorCode === 'DASHBOARD_AUTH_REAUTH_REQUIRED') return requestErrorCode
  if (requestErrorCode && !statusConfirmedAfterRequest) return requestErrorCode
  return statusErrorCode ?? null
}
