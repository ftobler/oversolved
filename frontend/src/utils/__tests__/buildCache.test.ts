import { describe, it, expect, beforeEach } from 'vitest'
import {
  computeCacheKey,
  getCachedBuildResponse,
  cacheBuildResponse,
  invalidateDocCache,
  invalidateAllCache,
  formatCacheAge,
} from '../buildCache'
import type { PartDoc, BuildResponse, PartFeature } from '../../types/cad'

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
})

describe('cacheBuildResponse / getCachedBuildResponse', () => {
  beforeEach(async () => {
    await invalidateAllCache()
  })

  it('stores and retrieves a response', async () => {
    const doc: PartDoc = { features: [{ id: 'sketch0', kind: 'sketch' }] }
    const response: BuildResponse = {
      solve_ms: 42,
      result: {},
      bodies: {},
    }
    await cacheBuildResponse('doc1', doc, 1, null, response)
    const cached = await getCachedBuildResponse('doc1', doc, 1, null)
    expect(cached).not.toBeNull()
    expect(cached!.entry.buildResponse.solve_ms).toBe(42)
    expect(cached!.isFresh).toBe(true)
  })

  it('returns null for cache miss', async () => {
    const doc: PartDoc = { features: [{ id: 'sketch0', kind: 'sketch' }] }
    const cached = await getCachedBuildResponse('doc1', doc, 1, null)
    expect(cached).toBeNull()
  })

  it('marks stale responses correctly', async () => {
    const doc: PartDoc = { features: [{ id: 'sketch0', kind: 'sketch' }] }
    const response: BuildResponse = {
      solve_ms: 42,
      result: {},
      bodies: {},
    }
    await cacheBuildResponse('doc1', doc, 1, null, response)

    // Manually age the entry beyond 5 minutes
    const key = await computeCacheKey('doc1', doc.features ?? [], 1, null)
    const { getRecord, saveRecord } = await import('../indexedDb')
    const entry = await getRecord(key) as { timestamp: number }
    entry.timestamp = Date.now() - 6 * 60 * 1000
    await saveRecord(entry)

    const cached = await getCachedBuildResponse('doc1', doc, 1, null)
    expect(cached).not.toBeNull()
    expect(cached!.isFresh).toBe(false)
  })

  it('invalidateDocCache removes entries for a doc', async () => {
    const doc: PartDoc = { features: [{ id: 'sketch0', kind: 'sketch' }] }
    const response: BuildResponse = { solve_ms: 42, result: {}, bodies: {} }
    await cacheBuildResponse('doc1', doc, 1, null, response)
    await invalidateDocCache('doc1')
    const cached = await getCachedBuildResponse('doc1', doc, 1, null)
    expect(cached).toBeNull()
  })

  it('invalidateAllCache removes all entries', async () => {
    const doc: PartDoc = { features: [{ id: 'sketch0', kind: 'sketch' }] }
    const response: BuildResponse = { solve_ms: 42, result: {}, bodies: {} }
    await cacheBuildResponse('doc1', doc, 1, null, response)
    await invalidateAllCache()
    const cached = await getCachedBuildResponse('doc1', doc, 1, null)
    expect(cached).toBeNull()
  })
})

describe('formatCacheAge', () => {
  it('formats just now for recent timestamps', () => {
    const text = formatCacheAge(Date.now() - 30 * 1000)
    expect(text).toBe('just now')
  })

  it('formats minutes ago', () => {
    const text = formatCacheAge(Date.now() - 3 * 60 * 1000)
    expect(text).toBe('3m ago')
  })

  it('formats single minute', () => {
    const text = formatCacheAge(Date.now() - 60 * 1000)
    expect(text).toBe('1m ago')
  })
})
