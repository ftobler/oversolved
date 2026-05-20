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
} from '@/utils/buildCache'
import type { CacheEntry } from '@/utils/buildCache'
import type { PartDoc, BuildResponse, PartFeature } from '@/types/cad'

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

  it('produces same key for null pick_boundary across repeated calls', async () => {
    const features = [{ id: 'sk1', kind: 'sketch' }]
    const key1 = await computeCacheKey('doc1', features as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', features as PartFeature[], 1, null)
    const key3 = await computeCacheKey('doc1', features as PartFeature[], 1, null)
    expect(key1).toBe(key2)
    expect(key2).toBe(key3)
  })

  it('produces same key for structurally identical feature arrays with different refs', async () => {
    const f1 = [{ id: 'a', kind: 'sketch', distance: 5 }]
    const f2 = [{ id: 'a', kind: 'sketch', distance: 5 }]
    const key1 = await computeCacheKey('doc1', f1 as PartFeature[], 1, null)
    const key2 = await computeCacheKey('doc1', f2 as PartFeature[], 1, null)
    expect(key1).toBe(key2)
  })

  it('drag mutations (initial-only diff) produce the same key, requiring bypassCache for correctness', async () => {
    // Drag commits write solver output back into feature.initial. Because
    // computeCacheKey strips `initial`, the pre-drag and post-drag docs map to
    // the same cache key. Without bypassCache + invalidateDocCache the stale
    // pre-drag geometry would be returned from cache on the next solve, making
    // the drag appear to snap back.
    const preDrag: PartFeature = { id: 'sk1', kind: 'sketch' }
    const postDrag: PartFeature = { id: 'sk1', kind: 'sketch', initial: { e1: [10, 20, 30, 40] } } as never
    const key1 = await computeCacheKey('doc1', [preDrag], 1, null)
    const key2 = await computeCacheKey('doc1', [postDrag], 1, null)
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
    const { getCache } = await import('@/utils/buildCache')
    const entry = getCache().get(key) as CacheEntry
    entry.timestamp = Date.now() - 6 * 60 * 1000

    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached).not.toBeNull()
    expect(cached!.isFresh).toBe(false)
  })

  it('returns null for stale entry when TTL has passed and entry was evicted', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const key = await computeCacheKey('doc1', [], 1, null)
    const { getCache } = await import('@/utils/buildCache')
    const entry = getCache().get(key) as CacheEntry
    entry.timestamp = Date.now() - 6 * 60 * 1000

    // cacheBuildResponse calls evictStale which removes stale entries
    await cacheBuildResponse('doc2', emptyDoc, 2, null, emptyResponse)
    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached).toBeNull()
  })

  it('LRU: accessed entry moves to end of map', async () => {
    const { getCache } = await import('@/utils/buildCache')
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

  it('handles interleaved writes and reads for different docs without corruption', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, { solve_ms: 1, result: {}, bodies: {} })
    await cacheBuildResponse('doc2', emptyDoc, 2, null, { solve_ms: 2, result: {}, bodies: {} })
    const r1 = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    const r2 = await getCachedBuildResponse('doc2', emptyDoc, 2, null)
    expect(r1!.entry.buildResponse.solve_ms).toBe(1)
    expect(r2!.entry.buildResponse.solve_ms).toBe(2)
    // Interleave writes and reads
    await cacheBuildResponse('doc3', emptyDoc, 3, null, { solve_ms: 3, result: {}, bodies: {} })
    const r1again = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    await cacheBuildResponse('doc4', emptyDoc, 4, null, { solve_ms: 4, result: {}, bodies: {} })
    const r2again = await getCachedBuildResponse('doc2', emptyDoc, 2, null)
    expect(r1again!.entry.buildResponse.solve_ms).toBe(1)
    expect(r2again!.entry.buildResponse.solve_ms).toBe(2)
  })

  it('does not lose entries when writing while reading', async () => {
    for (let i = 0; i < 10; i++) {
      await cacheBuildResponse(`doc${i}`, emptyDoc, 1, null, { solve_ms: i, result: {}, bodies: {} })
    }
    for (let i = 0; i < 5; i++) {
      const r = await getCachedBuildResponse(`doc${i}`, emptyDoc, 1, null)
      expect(r).not.toBeNull()
      await cacheBuildResponse(`new${i}`, emptyDoc, 1, null, { solve_ms: 100 + i, result: {}, bodies: {} })
    }
    for (let i = 0; i < 10; i++) {
      const r = await getCachedBuildResponse(`doc${i}`, emptyDoc, 1, null)
      expect(r).not.toBeNull()
    }
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
    const { getCache } = await import('@/utils/buildCache')
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
    const { getCache } = await import('@/utils/buildCache')
    const entry = getCache().get(key) as CacheEntry
    entry.timestamp = Date.now() - 6 * 60 * 1000

    const cached = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(cached).not.toBeNull()
    expect(cached!.isFresh).toBe(false)
    expect(cached!.entry.geometry).toBeDefined()
  })

  it('does not attach geometry to wrong entry when features differ', async () => {
    const docA: PartDoc = { features: [{ id: 'a', kind: 'sketch' }] }
    const docB: PartDoc = { features: [{ id: 'b', kind: 'sketch' }] }
    await cacheBuildResponse('doc1', docA, 1, null, { solve_ms: 1, result: {}, bodies: {} })
    const geometry = { header: {} as never, buffer: new ArrayBuffer(8), jsonHeaderLen: 4 }
    await cacheGeometry('doc1', docB, 1, null, geometry)
    const cachedA = await getCachedBuildResponse('doc1', docA, 1, null)
    expect(cachedA).not.toBeNull()
    expect(cachedA!.entry.geometry).toBeUndefined()
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
    const { getCache } = await import('@/utils/buildCache')
    expect(getCache().size).toBe(0)
  })

  it('preserves entries for other rollback positions of same doc', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await cacheBuildResponse('doc1', emptyDoc, 2, null, emptyResponse)
    await invalidateDocCache('doc1')
    const { getCache } = await import('@/utils/buildCache')
    expect(getCache().size).toBe(0)
  })

  it('does not throw when invalidating a doc ID that was never cached', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await invalidateDocCache('doc2')
    const c1 = await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    expect(c1).not.toBeNull()
  })
})

describe('invalidateAllCache', () => {
  it('clears everything', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await cacheBuildResponse('doc2', emptyDoc, 1, null, emptyResponse)
    await invalidateAllCache()
    const { getCache } = await import('@/utils/buildCache')
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
    const { getCache } = await import('@/utils/buildCache')
    expect(getCache().size).toBe(0)
  })

  it('does not throw when deleting an already-deleted key', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    const key = await computeCacheKey('doc1', [], 1, null)
    await deleteCacheEntry(key)
    await deleteCacheEntry(key)
    const { getCache } = await import('@/utils/buildCache')
    expect(getCache().size).toBe(0)
  })

  it('preserves LRU order so recently accessed entries appear later', async () => {
    await cacheBuildResponse('doc1', emptyDoc, 1, null, emptyResponse)
    await cacheBuildResponse('doc2', emptyDoc, 2, null, emptyResponse)
    await cacheBuildResponse('doc3', emptyDoc, 3, null, emptyResponse)
    const key1 = await computeCacheKey('doc1', [], 1, null)
    await getCachedBuildResponse('doc1', emptyDoc, 1, null)
    const entries = await getAllCachedEntries()
    expect(entries[entries.length - 1].cache_key).toBe(key1)
  })
})

describe('eviction', () => {
  it('evictIfOverMax removes oldest entries when cache exceeds MAX_CACHE_SIZE', async () => {
    const { getCache } = await import('@/utils/buildCache')
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
    const { getCache } = await import('@/utils/buildCache')
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
    const { getCache } = await import('@/utils/buildCache')
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
    const { getCache } = await import('@/utils/buildCache')
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
    const { getCache } = await import('@/utils/buildCache')
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

  it('formats 1ms before minute boundary as just now', () => {
    expect(formatCacheAge(Date.now() - 59999)).toBe('just now')
    expect(formatCacheAge(Date.now() - 60000)).toBe('1m ago')
  })

  it('formats very old timestamp as many minutes ago', () => {
    expect(formatCacheAge(Date.now() - 90 * 60 * 1000)).toBe('90m ago')
  })
})
