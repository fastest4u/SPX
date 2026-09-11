import assert from 'node:assert/strict'

import { selectProviderAuthFeedbackCode } from '../src/frontend/lib/provider-auth-feedback.ts'

assert.equal(
  selectProviderAuthFeedbackCode({
    statusErrorCode: 'challenge_required',
    requestErrorCode: 'PROVIDER_AUTH_FAILED',
    statusConfirmedAfterRequest: true,
  }),
  'challenge_required',
  'a newly confirmed provider status replaces stale generic mutation guidance',
)

assert.equal(
  selectProviderAuthFeedbackCode({
    statusErrorCode: 'challenge_required',
    requestErrorCode: 'DASHBOARD_AUTH_REAUTH_REQUIRED',
    statusConfirmedAfterRequest: true,
  }),
  'DASHBOARD_AUTH_REAUTH_REQUIRED',
  'dashboard reauthentication remains higher priority than provider guidance',
)

assert.equal(
  selectProviderAuthFeedbackCode({
    statusErrorCode: null,
    requestErrorCode: 'PROVIDER_AUTH_UNAVAILABLE',
    statusConfirmedAfterRequest: false,
  }),
  'PROVIDER_AUTH_UNAVAILABLE',
  'a mutation error remains visible until a confirmed provider error replaces it',
)

assert.equal(
  selectProviderAuthFeedbackCode({
    statusErrorCode: 'rate_limited',
    requestErrorCode: null,
    statusConfirmedAfterRequest: false,
  }),
  'rate_limited',
  'confirmed provider guidance renders without a mutation error',
)

assert.equal(
  selectProviderAuthFeedbackCode({
    statusErrorCode: 'challenge_required',
    requestErrorCode: 'PROVIDER_AUTH_RATE_LIMITED',
    statusConfirmedAfterRequest: false,
  }),
  'PROVIDER_AUTH_RATE_LIMITED',
  'a fresh mutation failure replaces cached pre-mutation provider guidance when status refresh fails',
)

assert.equal(
  selectProviderAuthFeedbackCode({
    statusErrorCode: null,
    requestErrorCode: 'PROVIDER_AUTH_FAILED',
    statusConfirmedAfterRequest: true,
  }),
  null,
  'a successful status read with no provider error clears stale mutation guidance',
)

console.log('frontend-provider-auth-feedback: all assertions passed')
