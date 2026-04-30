import type { PartDoc, BuildResponse, PartFeature } from '../types/cad'

const CACHE_TTL_MS = 5 * 60 * 1000

export interface CacheEntry {
  cache_key: string
  doc_id: string
  feature_spec_hash: string
  timestamp: number
  rollback_position: number
  pick_boundary: number | null
  buildResponse: BuildResponse
}

const cache = new Map<string, CacheEntry>()

export async function computeCacheKey(
  docId: string,
  features: PartFeature[],
  rollbackPosition: number,
  pickBoundary: number | null,
): Promise<string> {
  const payload = JSON.stringify({ features, rollbackPosition, pickBoundary })
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
  cache.set(key, entry)
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

export function _getCache(): Map<string, CacheEntry> {
  return cache
}

export function formatCacheAge(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1m ago'
  return `${minutes}m ago`
}
