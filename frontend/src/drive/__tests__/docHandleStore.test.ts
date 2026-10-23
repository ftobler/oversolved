// @vitest-environment node
//
// The MCP docHash store: content-addressed, bounded, and recency-refreshing on
// a hit. The entry script owns one instance; these tests pin the eviction
// policy the unknown-hash message promises.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { DocHandleStore, DOC_HANDLE_CAPACITY } from '../docHandleStore'
import { docHashOf } from '../docHash'

function doc(label: string): PartDoc {
  return { version: 1, kind: 'part', features: [{ id: label, kind: 'sketch' }] } as PartDoc
}

describe('DocHandleStore', () => {
  it('addresses a document by content, so putting it twice keeps one entry', () => {
    const store = new DocHandleStore()
    const first = store.put(doc('sk1'))
    const second = store.put(doc('sk1'))
    expect(second).toBe(first)
    expect(store.size()).toBe(1)
    expect(store.get(first)).toEqual(doc('sk1'))
  })

  it('clones on put and get, so a caller cannot mutate a document into a different handle', () => {
    const store = new DocHandleStore()
    const original = doc('sk1')
    const hash = store.put(original)
    const returned = store.get(hash)!
    returned.features![0].id = 'mutated'
    expect(store.get(hash)).toEqual(original)
    expect(docHashOf(store.get(hash)!)).toBe(hash)
  })

  it('returns undefined for an unknown hash', () => {
    expect(new DocHandleStore().get('not-a-doc')).toBeUndefined()
  })

  it('evicts the least recently used entry past the capacity', () => {
    const store = new DocHandleStore(3)
    const a = store.put(doc('a'))
    const b = store.put(doc('b'))
    const c = store.put(doc('c'))
    // A lookup is use: a must outlive b now.
    store.get(a)
    const d = store.put(doc('d'))
    expect(store.get(b)).toBeUndefined()
    expect(store.get(a)).toEqual(doc('a'))
    expect(store.get(c)).toEqual(doc('c'))
    expect(store.get(d)).toEqual(doc('d'))
  })

  it('keeps the last DOC_HANDLE_CAPACITY documents and evicts the next insert', () => {
    const store = new DocHandleStore()
    expect(DOC_HANDLE_CAPACITY).toBe(256)
    const hashes = Array.from({ length: DOC_HANDLE_CAPACITY }, (_, i) => store.put(doc(`f${i}`)))
    expect(store.size()).toBe(DOC_HANDLE_CAPACITY)
    const extra = store.put(doc('extra'))
    expect(store.size()).toBe(DOC_HANDLE_CAPACITY)
    expect(store.get(hashes[0])).toBeUndefined()
    expect(store.get(extra)).toEqual(doc('extra'))
  })

  it('keeps a hash fetched every five interleaved puts from two clients', () => {
    // Two MCP clients share one server process and one store. One hash is the
    // document their calls keep chaining on; it is fetched every fifth put, so
    // recency must protect it even in a store small enough to overflow.
    const store = new DocHandleStore(8)
    const pinned = store.put(doc('pinned'))
    let pinnedEvicted = false
    for (let call = 0; call < 40; call++) {
      // Alternate the clients: each put is a different document, as a fresh
      // reply from either session would be.
      store.put(doc(`client${call % 2}-${call}`))
      if (call % 5 === 0 && store.get(pinned) === undefined) pinnedEvicted = true
    }
    expect(pinnedEvicted).toBe(false)
    expect(store.get(pinned)).toEqual(doc('pinned'))
  })
})
