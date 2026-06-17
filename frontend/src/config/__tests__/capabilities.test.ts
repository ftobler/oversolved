import { describe, it, expect } from 'vitest'
import { resolveBackend, backend, hasBackend } from '../capabilities'

describe('capabilities.resolveBackend', () => {
  it('opts into static only on the explicit flag, defaults to http', () => {
    expect(resolveBackend('static')).toBe('static')
    expect(resolveBackend('http')).toBe('http')
    expect(resolveBackend(undefined)).toBe('http')
    expect(resolveBackend('')).toBe('http')
    expect(resolveBackend('STATIC')).toBe('http')  // case-sensitive, only exact match
  })

  it('defaults to the http backend when no runtime-config global is injected', () => {
    // Under test there is no /runtime-config.js, so window.__OVERSOLVED_BACKEND__
    // is undefined and the safe server-backed default holds.
    expect(window.__OVERSOLVED_BACKEND__).toBeUndefined()
    expect(backend).toBe('http')
    expect(hasBackend).toBe(true)
  })
})
