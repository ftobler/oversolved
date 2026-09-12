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

export function canonicalizeReferences(edges: ReferenceEdges): ReferenceEdges {
  const out: ReferenceEdges = {}
  for (const from of Object.keys(edges).sort()) {
    const targets = [...new Set(edges[from])].sort()
    if (targets.length > 0) out[from] = targets
  }
  return out
}
