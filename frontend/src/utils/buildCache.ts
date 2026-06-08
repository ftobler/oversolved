// In-memory build-response cache. Vestigial since the WS teardown: nothing
// populates this map anymore (the live cross-solve cache is the Worker's
// persistent checkpoint cache in `solveLocally`, keyed by doc id). Only the two
// invalidation hooks below survive, kept because `Part.tsx`'s "Clear cache and
// rebuild" and the redundant-solve test still call them; both are no-ops over
// the empty map. Wiring "Clear cache and rebuild" to the kernel checkpoint
// cache is a separate follow-up.

interface CacheEntry {
  doc_id: string
}

const cache = new Map<string, CacheEntry>()

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
