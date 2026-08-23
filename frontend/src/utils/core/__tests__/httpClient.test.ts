import { describe, it, expect } from 'vitest'
import { isConnectionError, parseHttpError, HttpError } from '@/utils/core/httpClient'

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

// review-08b: a proxy or load balancer can answer with an HTML error page instead
// of the app's JSON error format. parseHttpError must degrade to the caller's
// fallback rather than let JSON.parse's SyntaxError escape the caller's own catch.
describe('parseHttpError', () => {
  it('returns the server JSON error field when the body parses', () => {
    const e = new HttpError(400, JSON.stringify({ error: 'Name already taken' }))
    expect(parseHttpError(e, 'Failed to do X')).toBe('Name already taken')
  })

  it('falls back to the default when the body is valid JSON without an error field', () => {
    const e = new HttpError(400, JSON.stringify({ detail: 'nope' }))
    expect(parseHttpError(e, 'Failed to do X')).toBe('Failed to do X')
  })

  it('falls back to the default instead of throwing when the body is not JSON', () => {
    const e = new HttpError(502, '<html><body>502 Bad Gateway</body></html>')
    expect(() => parseHttpError(e, 'Failed to do X')).not.toThrow()
    expect(parseHttpError(e, 'Failed to do X')).toBe('Failed to do X')
  })

  it('falls back to the default when the body is empty', () => {
    const e = new HttpError(500, '')
    expect(parseHttpError(e, 'Failed to do X')).toBe('Failed to do X')
  })

  it('stringifies non-HttpError values (network errors, etc.)', () => {
    expect(parseHttpError(new TypeError('Failed to fetch'), 'Failed to do X')).toBe('TypeError: Failed to fetch')
  })
})
