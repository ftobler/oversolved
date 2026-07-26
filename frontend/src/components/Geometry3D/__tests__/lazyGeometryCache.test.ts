import { describe, it, expect, vi } from 'vitest'
import { lazyGeometryCache } from '@/components/Geometry3D/lazyGeometryCache'

/**
 * Body3D used to mint one BufferGeometry per face AND per edge when a body
 * mounted, for overlays that only ever draw for the handful of primitives under
 * the pointer or in the selection. On a heavy model that whole build sat between
 * the finished solve and the first painted frame. The cache below is what makes
 * it on-demand, so these tests are about WHEN work happens, not what it produces.
 */
describe('lazyGeometryCache', () => {
  const segments = (i: number) => new Float32Array([i, 0, 0, i, 1, 0])

  it('builds nothing until an index is asked for', () => {
    const build = vi.fn(segments)
    const cache = lazyGeometryCache(build)
    expect(build).not.toHaveBeenCalled()
    expect(cache.size()).toBe(0)
  })

  it('builds an index once and serves the same geometry afterwards', () => {
    const build = vi.fn(segments)
    const cache = lazyGeometryCache(build)
    const first = cache.get(3)
    expect(cache.get(3)).toBe(first)
    expect(build).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledWith(3)
    expect(first!.getAttribute('position').count).toBe(2)
  })

  it('caches the empty answer too, so a segment-less primitive is not retried', () => {
    const build = vi.fn(() => new Float32Array(0))
    const cache = lazyGeometryCache(build)
    expect(cache.get(1)).toBeNull()
    expect(cache.get(1)).toBeNull()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('treats a null build result as no geometry', () => {
    expect(lazyGeometryCache(() => null).get(0)).toBeNull()
  })

  it('disposes every geometry it handed out', () => {
    const cache = lazyGeometryCache(segments)
    const a = cache.get(0)!
    const b = cache.get(1)!
    const disposed: string[] = []
    a.addEventListener('dispose', () => disposed.push('a'))
    b.addEventListener('dispose', () => disposed.push('b'))
    cache.dispose()
    expect(disposed.sort()).toEqual(['a', 'b'])
    expect(cache.size()).toBe(0)
  })
})
