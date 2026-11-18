// The assembly Parts list as a tree, computed without React. A sub-assembly is
// a directory row whose children are the child document's own instances; the
// handle path is the tree key, so the same sub-assembly placed twice yields two
// distinct subtrees.
//
// Children are read-only from the parent: edit, delete, reorder and the doc
// `fixed`/`visible` writes all belong to the child document. The model marks
// them for the tree, which renders only select, the view-only eye and open in a
// new tab.

import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { partInstances } from '@/utils/assemblyMutations'

export interface AssemblyTreeNode {
  // The handle path joined by '/' (the same path form mate anchor ids use).
  key: string
  handlePath: string[]
  label: string
  docId: string
  kind: 'part' | 'assembly'
  depth: number
  // Only a top-level row belongs to this document and may be edited here.
  editable: boolean
  // A child assembly document that could not be read. The row still renders,
  // with no children, so the user sees the broken placement instead of a throw.
  failed?: boolean
  children: AssemblyTreeNode[]
}

export interface AssemblyTreeSource {
  // A loaded child assembly document, null when it could not be read, or
  // undefined while the load is still in flight.
  docFor(docId: string): AssemblyDoc | null | undefined
  kindOf(docId: string): 'part' | 'assembly' | undefined
  nameOf(handle: string, docId: string): string
}

/**
 * Build the Parts tree. `seen` is the doc-id stack of the current branch, so a
 * hand-edited document that places itself (or an ancestor) stops at the repeat
 * and marks the row failed rather than recursing forever.
 */
export function buildAssemblyTree(
  instances: readonly PartInstance[],
  source: AssemblyTreeSource,
): AssemblyTreeNode[] {
  return buildNodes(instances, source, [], 0, new Set())
}

function buildNodes(
  instances: readonly PartInstance[],
  source: AssemblyTreeSource,
  parentPath: readonly string[],
  depth: number,
  seen: ReadonlySet<string>,
): AssemblyTreeNode[] {
  return instances.map(inst => {
    const handlePath = [...parentPath, inst.handle]
    const key = handlePath.join('/')
    const label = source.nameOf(inst.handle, inst.doc_id)
    const kind = source.kindOf(inst.doc_id) === 'assembly' ? 'assembly' : 'part'
    const node: AssemblyTreeNode = {
      key,
      handlePath,
      label,
      docId: inst.doc_id,
      kind,
      depth,
      editable: depth === 0,
      children: [],
    }
    if (kind !== 'assembly') return node
    if (seen.has(inst.doc_id)) {
      return { ...node, failed: true }
    }
    const doc = source.docFor(inst.doc_id)
    if (doc === undefined) return node
    if (doc === null) return { ...node, failed: true }
    const childSeen = new Set([...seen, inst.doc_id])
    node.children = buildNodes(partInstances(doc), source, handlePath, depth + 1, childSeen)
    return node
  })
}

/** Flatten the tree in render order, for consumers that iterate rows. */
export function flattenAssemblyTree(nodes: readonly AssemblyTreeNode[]): AssemblyTreeNode[] {
  return nodes.flatMap(node => [node, ...flattenAssemblyTree(node.children)])
}

/**
 * The top-level instance handle a node's move belongs to: the first handle of
 * its path. Selecting a child selects this top-level sub-assembly, and its
 * `leafPath` is everything after the top handle, which is also the render
 * filter's key suffix.
 */
export function topHandleOf(node: AssemblyTreeNode): string {
  return node.handlePath[0]
}

export function leafPathOf(node: AssemblyTreeNode): string | undefined {
  return node.handlePath.length > 1 ? node.handlePath.slice(1).join('/') : undefined
}
