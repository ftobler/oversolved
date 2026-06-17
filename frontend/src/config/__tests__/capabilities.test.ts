import { describe, it, expect } from 'vitest'
import { resolveBackend } from '../capabilities'

describe('capabilities.resolveBackend', () => {
  it('opts into static only on the explicit flag, defaults to http', () => {
    expect(resolveBackend('static')).toBe('static')
    expect(resolveBackend('http')).toBe('http')
    expect(resolveBackend(undefined)).toBe('http')
    expect(resolveBackend('')).toBe('http')
    expect(resolveBackend('STATIC')).toBe('http')  // case-sensitive, only exact match
  })
})
