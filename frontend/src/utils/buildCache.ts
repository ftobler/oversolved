import type { PartDoc, BuildResponse, PartFeature } from '../types/cad'
import type { GeometryHeader } from './geometryUnpack'

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_SIZE = 100

export interface CachedGeometry {
  header: GeometryHeader
  buffer: ArrayBuffer
  jsonHeaderLen: number
}

export interface CacheEntry {
  cache_key: string
  doc_id: string
  feature_spec_hash: string
  timestamp: number
  rollback_position: number
  pick_boundary: number | null
  buildResponse: BuildResponse
  geometry?: CachedGeometry
}

const cache = new Map<string, CacheEntry>()

function evictStale(): void {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(key)
    }
  }
}

function evictIfOverMax(): void {
  if (cache.size <= MAX_CACHE_SIZE) return
  // Evict stale entries first, then oldest by access time (Map preserves insertion order;
  // getCachedBuildResponse moves accessed entries to end, so the front is LRU)
  evictStale()
  if (cache.size <= MAX_CACHE_SIZE) return
  const toDelete = cache.size - MAX_CACHE_SIZE
  const iter = cache.keys()
  for (let i = 0; i < toDelete; i++) {
    const key = iter.next().value
    if (key !== undefined) cache.delete(key)
  }
}

export async function computeCacheKey(
  docId: string,
  features: PartFeature[],
  rollbackPosition: number,
  pickBoundary: number | null,
): Promise<string> {
  // Strip solver output (initial field) from feature specs so cache key
  // depends only on the feature definition, not on solver results.
  const cleanFeatures = features.map(f => {
    const clean: Record<string, unknown> = {}
    for (const key of Object.keys(f)) {
      if (key !== 'initial') clean[key] = (f as unknown as Record<string, unknown>)[key]
    }
    return clean
  })
  const payload = JSON.stringify({ features: cleanFeatures, rollbackPosition, pickBoundary })
  const encoder = new TextEncoder()
  const data = encoder.encode(payload)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  return `${docId}:${hashHex}`
}

export async function getCachedBuildResponse(
  docId: string,
  doc: PartDoc,
  rollbackPosition: number,
  pickBoundary: number | null,
): Promise<{ entry: CacheEntry; isFresh: boolean } | null> {
  const features = doc.features ?? []
  const key = await computeCacheKey(docId, features, rollbackPosition, pickBoundary)
  const entry = cache.get(key)
  if (!entry) return null
  // Move to end on access (LRU)
  cache.delete(key)
  cache.set(key, entry)
  const age = Date.now() - entry.timestamp
  const isFresh = age < CACHE_TTL_MS
  return { entry, isFresh }
}

export async function cacheBuildResponse(
  docId: string,
  doc: PartDoc,
  rollbackPosition: number,
  pickBoundary: number | null,
  response: BuildResponse,
): Promise<void> {
  evictStale()
  const features = doc.features ?? []
  const key = await computeCacheKey(docId, features, rollbackPosition, pickBoundary)
  const entry: CacheEntry = {
    cache_key: key,
    doc_id: docId,
    feature_spec_hash: key.split(':')[1] ?? '',
    timestamp: Date.now(),
    rollback_position: rollbackPosition,
    pick_boundary: pickBoundary,
    buildResponse: response,
  }
  if (cache.has(key)) cache.delete(key)
  cache.set(key, entry)
  evictIfOverMax()
}

export async function cacheGeometry(
  docId: string,
  doc: PartDoc,
  rollbackPosition: number,
  pickBoundary: number | null,
  geometry: CachedGeometry,
): Promise<void> {
  const features = doc.features ?? []
  const key = await computeCacheKey(docId, features, rollbackPosition, pickBoundary)
  const entry = cache.get(key)
  if (entry) {
    entry.geometry = geometry
  }
}

export async function invalidateDocCache(docId: string): Promise<void> {
  for (const [key, entry] of cache) {
    if (entry.doc_id === docId) {
      cache.delete(key)
    }
  }
}

export async function invalidateAllCache(): Promise<void> {
  cache.clear()
}

export async function getAllCachedEntries(): Promise<CacheEntry[]> {
  return Array.from(cache.values())
}

export async function deleteCacheEntry(key: string): Promise<void> {
  cache.delete(key)
}

export function getCache(): Map<string, CacheEntry> {
  return cache
}

export function formatCacheAge(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1m ago'
  return `${minutes}m ago`
}
