// @vitest-environment node
//
// The MCP docHash store: content-addressed, bounded, and recency-refreshing on
// a hit. The entry script owns one instance; these tests pin the eviction
// policy the unknown-hash message promises.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, PartDoc } from '@/types/cad'
import { DocHandleStore, DOC_HANDLE_CAPACITY, assemblyHandleOf } from '../docHandleStore'
import { docHashOf } from '../docHash'

function doc(label: string): PartDoc {
  return { version: 1, kind: 'part', features: [{ id: label, kind: 'sketch' }] } as PartDoc
}

function assembly(handle: string): AssemblyDoc {
  return {
    version: 1,
    kind: 'assembly',
    features: [{ id: `inst_${handle}`, kind: 'part_instance', instance: {
      handle, doc_id: 'rail', doc_rev: 0, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    } }],
  }
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

describe('DocHandleStore assembly entries', () => {
  const rail = doc('rail')

  it('hashes an assembly as the assembly document plus its part hashes', () => {
    const store = new DocHandleStore()
    const hash = store.putAssembly(assembly('left'), { rail })
    expect(hash).toBe(docHashOf({ assembly: assembly('left'), parts: { rail: docHashOf(rail) } }))
    expect(store.getEntry(hash)).toMatchObject({ kind: 'assembly', parts: { rail } })
    // The part is readable at its own hash.
    expect(store.get(docHashOf(rail))).toEqual(rail)
  })

  it('changes the handle when the bound part content changes', () => {
    const store = new DocHandleStore()
    const first = store.putAssembly(assembly('left'), { rail })
    const second = store.putAssembly(assembly('left'), { rail: doc('rail2') })
    expect(second).not.toBe(first)
    expect(assemblyHandleOf(assembly('left'), { rail })).toBe(first)
  })

  it('re-puts the parts when an assembly is read', () => {
    const store = new DocHandleStore(2)
    const hash = store.putAssembly(assembly('left'), { rail })
    // Evict the part by filling the store; the assembly entry survives.
    store.put(doc('other'))
    expect(store.get(docHashOf(rail))).toBeUndefined()
    // Reading the assembly re-puts its parts.
    expect(store.getEntry(hash)?.kind).toBe('assembly')
    expect(store.get(docHashOf(rail))).toEqual(rail)
  })

  it('keeps an assembly resolvable after its part handle is evicted', () => {
    const store = new DocHandleStore(2)
    const hash = store.putAssembly(assembly('left'), { rail })
    store.put(doc('x'))
    expect(store.get(docHashOf(rail))).toBeUndefined()
    const entry = store.getEntry(hash)
    expect(entry?.kind).toBe('assembly')
    if (entry?.kind !== 'assembly') throw new Error('unreachable')
    expect(entry.doc).toEqual(assembly('left'))
  })

  it('clones on putAssembly and getEntry, so a caller cannot rewrite the handle', () => {
    const store = new DocHandleStore()
    const source = assembly('left')
    const hash = store.putAssembly(source, { rail })
    source.features![0].instance!.handle = 'mutated'
    const entry = store.getEntry(hash)
    if (entry?.kind !== 'assembly') throw new Error('unreachable')
    entry.doc.features![0].instance!.handle = 'also-mutated'
    entry.parts.rail.features![0].id = 'also-mutated'
    const again = store.getEntry(hash)
    if (again?.kind !== 'assembly') throw new Error('unreachable')
    expect(again.doc).toEqual(assembly('left'))
    expect(again.parts.rail).toEqual(rail)
  })

  it('keeps a part handle distinct from an assembly handle', () => {
    const store = new DocHandleStore()
    const partHash = store.put(rail)
    const assemblyHash = store.putAssembly(assembly('left'), { rail })
    expect(partHash).not.toBe(assemblyHash)
    expect(store.get(assemblyHash)).toBeUndefined()
    expect(store.getEntry(partHash)).toMatchObject({ kind: 'part' })
  })
})
