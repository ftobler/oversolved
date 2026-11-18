import type { ReferenceEdges, WorkspaceTree } from './types'

export interface ResolvedEdge {
  from: string
  to: string
  resolved: boolean
}

// An edge carries no kind. Whether an assembly may reference an assembly is a
// mutation-site policy (A7, C3's I8), not a shape the format can express.
export function addReference(tree: WorkspaceTree, from: string, to: string): void {
  const current = tree.manifest.references[from] ?? []
  tree.manifest.references[from] = [...new Set([...current, to])].sort()
}

export function removeReference(tree: WorkspaceTree, from: string, to: string): void {
  const current = tree.manifest.references[from]
  if (!current) return
  const next = current.filter(id => id !== to)
  if (next.length === 0) delete tree.manifest.references[from]
  else tree.manifest.references[from] = next
}

export function referencesOf(tree: WorkspaceTree, from: string): string[] {
  return [...(tree.manifest.references[from] ?? [])]
}

export function referentsOf(tree: WorkspaceTree, to: string): string[] {
  const out: string[] = []
  for (const [from, targets] of Object.entries(tree.manifest.references)) {
    if (targets.includes(to)) out.push(from)
  }
  return out.sort()
}

// A dangling edge is a legal format state (C3's manifest-less mint branch
// produces them), so this reports instead of throwing and never reads content.
export function resolveReferences(tree: WorkspaceTree): ResolvedEdge[] {
  const edges: ResolvedEdge[] = []
  for (const from of Object.keys(tree.manifest.references).sort()) {
    for (const to of tree.manifest.references[from]) {
      edges.push({ from, to, resolved: tree.manifest.entries[to] !== undefined })
    }
  }
  return edges
}

/**
 * The reference path from `candidate` down to `host`, or null when `host` is not
 * reachable from `candidate`. This is the cycle rule for placing an assembly:
 * `candidate` already reaching `host` means a new `host -> candidate` edge would
 * close the loop. Self is the zero-length path (`[host]`).
 *
 * Breadth-first with a visited set rather than a recursive walk: a hand-edited
 * workspace can already hold a cycle, and a path through it must terminate
 * rather than overflow the stack.
 */
export function cyclePath(references: ReferenceEdges, host: string, candidate: string): string[] | null {
  if (candidate === host) return [host]
  const parent = new Map<string, string>()
  const seen = new Set<string>([candidate])
  const queue: string[] = [candidate]
  while (queue.length > 0) {
    const from = queue.shift()!
    for (const to of references[from] ?? []) {
      if (seen.has(to)) continue
      seen.add(to)
      parent.set(to, from)
      if (to === host) {
        const path: string[] = [host]
        let at = host
        while (at !== candidate) {
          at = parent.get(at)!
          path.push(at)
        }
        return path.reverse()
      }
      queue.push(to)
    }
  }
  return null
}

/** True when placing `candidate` inside `host` would make `host` reach itself. */
export function wouldCreateCycle(references: ReferenceEdges, host: string, candidate: string): boolean {
  return cyclePath(references, host, candidate) !== null
}

export function canonicalizeReferences(edges: ReferenceEdges): ReferenceEdges {
  const out: ReferenceEdges = {}
  for (const from of Object.keys(edges).sort()) {
    const targets = [...new Set(edges[from])].sort()
    if (targets.length > 0) out[from] = targets
  }
  return out
}
