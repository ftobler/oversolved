// The assembly document graph, resolved on the main thread: which referenced
// document is a part and which is a sub-assembly, and the recursive bundle key
// each one caches under. The worker never reads the workspace manifest, so this
// is where a sub-assembly's identity is decided.

import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { partInstances } from '@/utils/assemblyMutations'
import { assemblyBundleKey, partBundleKey } from '@/workspace/contentHash'
import { MAX_SUBASSEMBLY_DEPTH } from './assemblyBundle'

/** What the graph needs to know about one workspace entry. */
export interface DocGraphEntry {
  kind: 'part' | 'assembly'
  contentHash: string
  // A part's one-level file dependencies. An unknown dependency is not an empty
  // list: the part bypasses the cache, exactly like `currentHashes` has always
  // required.
  fileHashes?: string[]
}

export interface AssemblyGraphSource {
  entry(docId: string): DocGraphEntry | null
  // The parsed assembly document, or null when it is missing, trashed or
  // malformed. A failed read is a refused placement, never a silent skip.
  readAssembly(docId: string): Promise<AssemblyDoc | null>
}

export interface AssemblyHashResult {
  // Doc id -> bundle key, covering every part and every assembly in the tree.
  // The composite of an assembly is keyed by its own recursive key; its leaves'
  // keys ride along because the child solve needs them.
  hashes: Record<string, string>
  // False when any input hash is unknown. The composite key of an ancestor is
  // then omitted, which is a cache bypass, not a stale hit.
  complete: boolean
}

/**
 * Recursively key every document reachable from these instances. A part keys on
 * its content plus its file hashes; an assembly keys on its content plus its
 * children's keys, which is what makes a deep edit invalidate every ancestor.
 *
 * A cycle or the depth cap stops that branch rather than recursing forever. The
 * composite resolver reports the refusal by name; this function only refuses to
 * invent a key for an unresolvable subtree.
 */
export async function assemblyHashes(
  instances: readonly PartInstance[],
  source: AssemblyGraphSource,
  stack: ReadonlySet<string> = new Set(),
  depth = 0,
): Promise<AssemblyHashResult> {
  const hashes: Record<string, string> = {}
  let complete = true

  for (const inst of instances) {
    if (hashes[inst.doc_id] !== undefined) continue
    const entry = source.entry(inst.doc_id)
    if (!entry) {
      complete = false
      continue
    }
    if (entry.kind === 'part') {
      if (entry.fileHashes === undefined) {
        complete = false
        continue
      }
      hashes[inst.doc_id] = partBundleKey(entry.contentHash, entry.fileHashes)
      continue
    }
    if (stack.has(inst.doc_id) || depth >= MAX_SUBASSEMBLY_DEPTH) {
      complete = false
      continue
    }
    const child = await source.readAssembly(inst.doc_id)
    if (!child) {
      complete = false
      continue
    }
    const children = await assemblyHashes(
      partInstances(child),
      source,
      new Set([...stack, inst.doc_id]),
      depth + 1,
    )
    Object.assign(hashes, children.hashes)
    if (children.complete) {
      hashes[inst.doc_id] = assemblyBundleKey(entry.contentHash, Object.values(children.hashes))
    } else {
      complete = false
    }
  }

  return { hashes, complete }
}
