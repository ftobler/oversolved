import { describe, it, expect } from 'vitest'
import { isConnectionError, HttpError } from '@/utils/core/httpClient'

// session-logout-offline: tell "the cloud is unreachable" (a rejected fetch with no
// response) apart from "the server answered with an error status" (an HttpError).
describe('isConnectionError', () => {
  it('treats a non-HttpError rejection as a connection failure (server unreachable)', () => {
    expect(isConnectionError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isConnectionError(new Error('network down'))).toBe(true)
    expect(isConnectionError('boom')).toBe(true)
  })

  it('treats an HttpError (the server responded) as NOT a connection failure', () => {
    expect(isConnectionError(new HttpError(401, 'unauthorized'))).toBe(false)
    expect(isConnectionError(new HttpError(500, 'server error'))).toBe(false)
  })
})
