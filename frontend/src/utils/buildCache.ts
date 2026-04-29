import type { PartDoc, BuildResponse, PartFeature } from '../types/cad'
import { getRecord, saveRecord, deleteByDocId, clearAll } from './indexedDb'

const CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes

interface CacheEntry {
  cache_key: string
  doc_id: string
  feature_spec_hash: string
  timestamp: number
  rollback_position: number
  pick_boundary: number | null
  buildResponse: BuildResponse
}

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
  const record = await getRecord(key)
  if (!record) return null

  const entry = record as CacheEntry
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
  await saveRecord(entry)
}

export async function invalidateDocCache(docId: string): Promise<void> {
  await deleteByDocId(docId)
}

export async function invalidateAllCache(): Promise<void> {
  await clearAll()
}

export function formatCacheAge(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1m ago'
  return `${minutes}m ago`
}
