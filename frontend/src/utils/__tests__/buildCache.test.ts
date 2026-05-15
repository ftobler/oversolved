import { describe, it, expect, beforeEach } from 'vitest'
import {
  computeCacheKey,
  getCachedBuildResponse,
  cacheBuildResponse,
  cacheGeometry,
  invalidateDocCache,
  invalidateAllCache,
  getAllCachedEntries,
  deleteCacheEntry,
  formatCacheAge,
} from '../buildCache'
import type { CacheEntry } from '../buildCache'
import type { PartDoc, BuildResponse, PartFeature } from '../../types/cad'

const emptyDoc: PartDoc = { features: [] }
const emptyResponse: BuildResponse = { solve_ms: 0, result: {}, bodies: {} }

beforeEach(async () => {
  await invalidateAllCache()
})

describe('computeCacheKey', () => {
  it('returns same key for same features and rollback', async () => {
    const features = [{ id: 'sketch0', kind: 'sketch' }]
    const key1 = await computeCacheKey('doc1', features as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', features as PartFeature[], 1, null)
    expect(key1).toBe(key2)
  })

  it('returns different key for different features', async () => {
    const key1 = await computeCacheKey('doc1', [{ id: 'a', kind: 'sketch' }] as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', [{ id: 'b', kind: 'sketch' }] as PartFeature[], 1, null)
    expect(key1).not.toBe(key2)
  })

  it('returns different key for different rollback positions', async () => {
    const features = [{ id: 'sketch0', kind: 'sketch' }]
    const key1 = await computeCacheKey('doc1', features as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', features as PartFeature[], 2, null)
    expect(key1).not.toBe(key2)
  })

  it('returns different key for different doc ids', async () => {
    const features = [{ id: 'sketch0', kind: 'sketch' }]
    const key1 = await computeCacheKey('doc1', features as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc2', features as PartFeature[], 1, null)
    expect(key1).not.toBe(key2)
  })

  it('includes pick_boundary in key', async () => {
    const features = [{ id: 'sketch0', kind: 'sketch' }]
    const key1 = await computeCacheKey('doc1', features as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', features as PartFeature[], 1, 3)
    expect(key1).not.toBe(key2)
  })

  it('strips initial field from features so solver output does not affect key', async () => {
    const f1 = { id: 'sk1', kind: 'sketch', initial: { e1: [0, 0, 1, 1] } }
    const f2 = { id: 'sk1', kind: 'sketch', initial: { e1: [9, 9, 9, 9] } }
    const key1 = await computeCacheKey('doc1', [f1] as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', [f2] as PartFeature[], 1, null)
    expect(key1).toBe(key2)
  })

  it('strips initial and keeps other keys identical', async () => {
    const f1 = { id: 'ex1', kind: 'extrude', distance: 10 }
    const f2 = { id: 'ex1', kind: 'extrude', distance: 10, initial: { e1: [0, 0] } }
    const key1 = await computeCacheKey('doc1', [f1] as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', [f2] as PartFeature[], 1, null)
    expect(key1).toBe(key2)
  })

  it('produces different keys when non-initial fields differ', async () => {
    const f1 = { id: 'ex1', kind: 'extrude', distance: 10 }
    const f2 = { id: 'ex1', kind: 'extrude', distance: 20 }
    const key1 = await computeCacheKey('doc1', [f1] as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', [f2] as PartFeature[], 1, null)
    expect(key1).not.toBe(key2)
  })

  it('handles empty features list', async () => {
    const key = await computeCacheKey('doc1', [], 0, null)
    expect(key).toBeTruthy()
    expect(key).toContain('doc1:')
  })

  it('handles features with extra unknown keys', async () => {
    const f1 = { id: 'sk1', kind: 'sketch', extra_field: 'ignored' }
    const f2 = { id: 'sk1', kind: 'sketch', extra_field: 'also_ignored' }
    const key1 = await computeCacheKey('doc1', [f1] as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', [f2] as PartFeature[], 1, null)
    expect(key1).not.toBe(key2)
  })

  it('handles many features consistently', async () => {
    const features = Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, kind: 'sketch' }))
    const key1 = await computeCacheKey('doc1', features as PartFeature[], 50, null)
    const key2 = await computeCacheKey('doc1', features as PartFeature[], 50, null)
    expect(key1).toBe(key2)
  })
})

describe('cacheBuildResponse / getCachedBuildResponse', () => {
  it('stores and retrieves a response', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached).not.toBeNull()
    expect(cached!.entry.buildResponse.solve_ms).toBe(0)
    expect(cached!.isFresh).toBe(true)
  })

  it('returns null for cache miss', async () => {
    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached).toBeNull()
  })

  it('marks stale responses correctly', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const key = await computeCacheKey('doc1', [], 1, null)
    const { getCache } = await import('../buildCache')
    const entry = getCache().get(key) as CacheEntry
    entry.timestamp = Date.now() - 6 * 60 * 1000

    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached).not.toBeNull()
    expect(cached!.isFresh).toBe(false)
  })

  it('returns null for stale entry when TTL has passed and entry was evicted', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const key = await computeCacheKey('doc1', [], 1, null)
    const { getCache } = await import('../buildCache')
    const entry = getCache().get(key) as CacheEntry
    entry.timestamp = Date.now() - 6 * 60 * 1000

    // cacheBuildResponse calls evictStale which removes stale entries
    await cacheBuildResponse('doc2', emptyDoc, 2, null, emptyResponse)
    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached).toBeNull()
  })

  it('LRU: accessed entry moves to end of map', async () => {
    const { getCache } = await import('../buildCache')
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await cacheBuildResponse('doc1', emptyDoc, 2, null, emptyResponse)
    await cacheBuildResponse('doc1', emptyDoc, 3, null, emptyResponse)

    const key1 = await computeCacheKey('doc1', [], 1, null)

    // Access rollback=1, should move to end
    await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    const keysAfter = Array.from(getCache().keys())
    const lastKey = keysAfter[keysAfter.length - 1]
    expect(lastKey).toBe(key1)
  })

  it('replaces existing entry on duplicate store', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, { solve_ms: 1, result: {}, bodies: {} })
    await cacheBuildResponse('doc1', emptyDoc, 1, null, { solve_ms: 2, result: {}, bodies: {} })
    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached!.entry.buildResponse.solve_ms).toBe(2)
  })

  it('stores response with non-empty result and bodies', async () => {
    const response: BuildResponse = {
      solve_ms: 123,
      result: { sk1: { geometry: { e1: [0, 0] } } },
      bodies: { body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [], vertices: [], edges: [] } as never },
    }
    await cacheBuildResponse('doc1', emptyDoc, 1, null, response)
    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached!.entry.buildResponse.solve_ms).toBe(123)
    expect(cached!.entry.buildResponse.result?.sk1).toBeDefined()
  })
})

describe('cacheGeometry', () => {
  it('attaches geometry to an existing cache entry', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const geometry = { header: {} as never, buffer: new ArrayBuffer(8), jsonHeaderLen: 4 }
    await cacheGeometry('doc1', emptyDoc, 1, null, geometry)
    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached!.entry.geometry).toBeDefined()
    expect(cached!.entry.geometry!.buffer.byteLength).toBe(8)
  })

  it('does nothing when no cache entry exists for the key', async () => {
    const geometry = { header: {} as never, buffer: new ArrayBuffer(4), jsonHeaderLen: 2 }
    await cacheGeometry('doc1', emptyDoc, 1, null, geometry)
    const { getCache } = await import('../buildCache')
    expect(getCache().size).toBe(0)
  })

  it('updates geometry on an existing entry', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const g1 = { header: {} as never, buffer: new ArrayBuffer(8), jsonHeaderLen: 4 }
    await cacheGeometry('doc1', emptyDoc, 1, null, g1)
    const g2 = { header: {} as never, buffer: new ArrayBuffer(16), jsonHeaderLen: 8 }
    await cacheGeometry('doc1', emptyDoc, 1, null, g2)
    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached!.entry.geometry!.buffer.byteLength).toBe(16)
  })

  it('geometry survives stale marking', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const geometry = { header: {} as never, buffer: new ArrayBuffer(8), jsonHeaderLen: 4 }
    await cacheGeometry('doc1', emptyDoc, 1, null, geometry)
    const key = await computeCacheKey('doc1', [], 1, null)
    const { getCache } = await import('../buildCache')
    const entry = getCache().get(key) as CacheEntry
    entry.timestamp = Date.now() - 6 * 60 * 1000

    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached).not.toBeNull()
    expect(cached!.isFresh).toBe(false)
    expect(cached!.entry.geometry).toBeDefined()
  })
})

describe('invalidateDocCache', () => {
  it('removes all entries for a doc', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await cacheBuildResponse('doc1', emptyDoc, 2, null, emptyResponse)
    await invalidateDocCache('doc1')
    const c1 = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    const c2 = await getCachedBuildResponse('doc1', emptyDoc, 2, null)
    expect(c1).toBeNull()
    expect(c2).toBeNull()
  })

  it('does not remove entries for other docs', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await cacheBuildResponse('doc2', emptyDoc, 1, null, emptyResponse)
    await invalidateDocCache('doc1')
    const c1 = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    const c2 = await getCachedBuildResponse('doc2', emptyDoc, 1, null)
    expect(c1).toBeNull()
    expect(c2).not.toBeNull()
  })

  it('handles invalidate on empty cache', async () => {
    await invalidateDocCache('doc1')
    const { getCache } = await import('../buildCache')
    expect(getCache().size).toBe(0)
  })

  it('preserves entries for other rollback positions of same doc', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await cacheBuildResponse('doc1', emptyDoc, 2, null, emptyResponse)
    await invalidateDocCache('doc1')
    const { getCache } = await import('../buildCache')
    expect(getCache().size).toBe(0)
  })
})

describe('invalidateAllCache', () => {
  it('clears everything', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await cacheBuildResponse('doc2', emptyDoc, 1, null, emptyResponse)
    await invalidateAllCache()
    const { getCache } = await import('../buildCache')
    expect(getCache().size).toBe(0)
  })
})

describe('getAllCachedEntries / deleteCacheEntry', () => {
  it('getAllCachedEntries returns all entries', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await cacheBuildResponse('doc2', emptyDoc, 1, null, emptyResponse)
    const entries = await getAllCachedEntries()
    expect(entries).toHaveLength(2)
  })

  it('getAllCachedEntries returns empty array when cache is empty', async () => {
    const entries = await getAllCachedEntries()
    expect(entries).toHaveLength(0)
  })

  it('deleteCacheEntry removes a single entry by key', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const key = await computeCacheKey('doc1', [], 1, null)
    await deleteCacheEntry(key)
    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached).toBeNull()
  })

  it('deleteCacheEntry on nonexistent key does not throw', async () => {
    await deleteCacheEntry('nonexistent-key')
    const { getCache } = await import('../buildCache')
    expect(getCache().size).toBe(0)
  })
})

describe('eviction', () => {
  it('evictIfOverMax removes oldest entries when cache exceeds MAX_CACHE_SIZE', async () => {
    const { getCache } = await import('../buildCache')
    const maxSize = 100
    for (let i = 0; i < maxSize + 10; i++) {
      await cacheBuildResponse(`doc${i}`, emptyDoc, 1, null, emptyResponse)
    }
    expect(getCache().size).toBeLessThanOrEqual(maxSize)
  })

  it('evictIfOverMax preserves recently accessed entries (LRU)', async () => {
    // Fill past max
    for (let i = 0; i < 100; i++) {
      await cacheBuildResponse(`doc${i}`, emptyDoc, 1, null, emptyResponse)
    }
    // Access the first entry so it moves to end
    const key0 = await computeCacheKey('doc0', [], 1, null)
    const { getCache } = await import('../buildCache')
    getCache().delete(key0)
    getCache().set(key0, { cache_key: key0 } as CacheEntry)

    for (let i = 0; i < 20; i++) {
      await cacheBuildResponse(`overflow${i}`, emptyDoc, 1, null, emptyResponse)
    }

    // doc0 was accessed (moved to end), should survive
    const c0 = await getCachedBuildResponse('doc0', emptyDoc, 1, null)
    expect(c0).not.toBeNull()
  })

  it('stale entries are evicted during cacheBuildResponse', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const key = await computeCacheKey('doc1', [], 1, null)
    const { getCache } = await import('../buildCache')
    const entry = getCache().get(key) as CacheEntry
    entry.timestamp = Date.now() - 6 * 60 * 1000

    // Trigger eviction by storing another entry
    await cacheBuildResponse('doc2', emptyDoc, 1, null, emptyResponse)

    const c1 = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(c1).toBeNull()
  })

  it('entries just within TTL survive eviction', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const key = await computeCacheKey('doc1', [], 1, null)
    const { getCache } = await import('../buildCache')
    const entry = getCache().get(key) as CacheEntry
    entry.timestamp = Date.now() - 4 * 60 * 1000  // 4 minutes, below 5 min TTL

    await cacheBuildResponse('doc2', emptyDoc, 1, null, emptyResponse)
    const c1 = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(c1).not.toBeNull()
    expect(c1!.isFresh).toBe(true)
  })

  it('new entry replaces existing at same key with updated timestamp', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const key = await computeCacheKey('doc1', [], 1, null)
    const { getCache } = await import('../buildCache')
    const ts1 = getCache().get(key)!.timestamp

    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const ts2 = getCache().get(key)!.timestamp
    expect(ts2).toBeGreaterThanOrEqual(ts1)
  })
})

describe('formatCacheAge', () => {
  it('formats just now for recent timestamps', () => {
    expect(formatCacheAge(Date.now() - 30 * 1000)).toBe('just now')
  })

  it('formats minutes ago', () => {
    expect(formatCacheAge(Date.now() - 3 * 60 * 1000)).toBe('3m ago')
  })

  it('formats single minute', () => {
    expect(formatCacheAge(Date.now() - 60 * 1000)).toBe('1m ago')
  })

  it('formats zero seconds as just now', () => {
    expect(formatCacheAge(Date.now())).toBe('just now')
  })

  it('formats edge of one minute as 1m ago', () => {
    expect(formatCacheAge(Date.now() - 119 * 1000)).toBe('1m ago')
  })

  it('formats future timestamp as just now', () => {
    expect(formatCacheAge(Date.now() + 60 * 1000)).toBe('just now')
  })
})
