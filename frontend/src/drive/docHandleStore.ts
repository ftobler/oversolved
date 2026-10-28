// The bounded, content-addressed document store behind the MCP `docHash`
// argument. The entry script owns the instance; the protocol module only
// parses the argument shape, and this module does no I/O.
//
// Content addressing is deliberate: the same document always has the same
// name, so a stale handle cannot silently point at changed content. The store
// dies with the server; the hash stays reproducible by re-running the script.
//
// An assembly handle is composite (D2): it folds the assembly document AND the
// content hash of every bound part, so a part edit yields a new assembly handle
// and a chained `measure {docHash}` needs no second argument. The part docs are
// copied into the entry, so evicting a part handle cannot strand an assembly
// handle; every get of an assembly re-puts its parts so their own hashes stay
// readable.
//
// Both put and get clone, so a caller that mutates a returned document cannot
// change what the hash names. The clone is the by-reference invariant: the
// stored content is exactly the content the handle was minted from.

import type { AssemblyDoc, PartDoc } from '@/types/cad'
import { docHashOf } from '@/drive/docHash'

/** The number of documents the server keeps alive for docHash chaining. A
 *  server process is shared by every client, so the bound must survive several
 *  interleaved sessions' worth of replies; documents are small. */
export const DOC_HANDLE_CAPACITY = 256

export type StoredDoc =
  | { kind: 'part'; doc: PartDoc }
  | { kind: 'assembly'; doc: AssemblyDoc; parts: Record<string, PartDoc> }

/** The composite content hash of an assembly and its binding (D2). */
export function assemblyHandleOf(doc: AssemblyDoc, parts: Record<string, PartDoc>): string {
  const hashes: Record<string, string> = {}
  for (const [docId, partDoc] of Object.entries(parts)) hashes[docId] = docHashOf(partDoc)
  return docHashOf({ assembly: doc, parts: hashes })
}

export class DocHandleStore {
  // Map iteration order is recency order: a lookup re-inserts at the end.
  private readonly docs = new Map<string, StoredDoc>()
  private readonly capacity: number

  constructor(capacity: number = DOC_HANDLE_CAPACITY) {
    this.capacity = capacity
  }

  private evict(): void {
    while (this.docs.size > this.capacity) {
      const oldest = this.docs.keys().next()
      if (oldest.done) break
      this.docs.delete(oldest.value)
    }
  }

  private remember(hash: string, entry: StoredDoc): string {
    this.docs.delete(hash)
    this.docs.set(hash, entry)
    this.evict()
    return hash
  }

  // Store a part document and return its content hash.
  put(doc: PartDoc): string {
    return this.putAs(docHashOf(doc), doc)
  }

  // Store a part under a caller-computed hash, for a document that arrived as a
  // JSON payload: the handle then names the bytes the client sent, not the
  // loader's normalized copy. The stored value is still cloned.
  putAs(hash: string, doc: PartDoc): string {
    return this.remember(hash, { kind: 'part', doc: structuredClone(doc) })
  }

  /**
   * Store an assembly and its binding. Every part is stored under its own hash
   * first, so the part docs stay readable at their own handles; the assembly is
   * stored last so the composite handle is the most recent entry.
   */
  putAssembly(doc: AssemblyDoc, parts: Record<string, PartDoc>): string {
    const clonedParts: Record<string, PartDoc> = {}
    for (const [docId, partDoc] of Object.entries(parts)) {
      const cloned = structuredClone(partDoc)
      clonedParts[docId] = cloned
      this.putAs(docHashOf(cloned), cloned)
    }
    const hash = assemblyHandleOf(doc, clonedParts)
    return this.remember(hash, { kind: 'assembly', doc: structuredClone(doc), parts: clonedParts })
  }

  // Look a part document up; a hit refreshes its recency. An assembly handle
  // is not a part, so it reads as undefined here (getEntry serves both).
  get(hash: string): PartDoc | undefined {
    const entry = this.docs.get(hash)
    if (entry === undefined) return undefined
    this.docs.delete(hash)
    this.docs.set(hash, entry)
    if (entry.kind !== 'part') return undefined
    return structuredClone(entry.doc)
  }

  /** Look either kind up. An assembly hit re-puts its parts so their own
   *  handles stay live (D2). */
  getEntry(hash: string): StoredDoc | undefined {
    const entry = this.docs.get(hash)
    if (entry === undefined) return undefined
    this.docs.delete(hash)
    this.docs.set(hash, entry)
    if (entry.kind === 'part') return { kind: 'part', doc: structuredClone(entry.doc) }
    const parts: Record<string, PartDoc> = {}
    for (const [docId, partDoc] of Object.entries(entry.parts)) {
      const cloned = structuredClone(partDoc)
      parts[docId] = cloned
      this.putAs(docHashOf(cloned), cloned)
    }
    this.remember(hash, entry)
    return { kind: 'assembly', doc: structuredClone(entry.doc), parts }
  }

  size(): number {
    return this.docs.size
  }
}
