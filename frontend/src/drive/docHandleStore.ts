// The bounded, content-addressed document store behind the MCP `docHash`
// argument. The entry script owns the instance; the protocol module only
// parses the argument shape, and this module does no I/O.
//
// Content addressing is deliberate: the same document always has the same
// name, so a stale handle cannot silently point at changed content. The store
// dies with the server; the hash stays reproducible by re-running the script.

import type { PartDoc } from '@/types/cad'
import { docHashOf } from '@/drive/docHash'

/** The number of documents the server keeps alive for docHash chaining. */
export const DOC_HANDLE_CAPACITY = 32

export class DocHandleStore {
  // Map iteration order is recency order: a lookup re-inserts at the end.
  private readonly docs = new Map<string, PartDoc>()
  private readonly capacity: number

  constructor(capacity: number = DOC_HANDLE_CAPACITY) {
    this.capacity = capacity
  }

  // Store a document and return its content hash.
  put(doc: PartDoc): string {
    const hash = docHashOf(doc)
    this.docs.delete(hash)
    this.docs.set(hash, doc)
    while (this.docs.size > this.capacity) {
      const oldest = this.docs.keys().next()
      if (oldest.done) break
      this.docs.delete(oldest.value)
    }
    return hash
  }

  // Look a document up; a hit refreshes its recency.
  get(hash: string): PartDoc | undefined {
    const doc = this.docs.get(hash)
    if (doc === undefined) return undefined
    this.docs.delete(hash)
    this.docs.set(hash, doc)
    return doc
  }

  size(): number {
    return this.docs.size
  }
}
