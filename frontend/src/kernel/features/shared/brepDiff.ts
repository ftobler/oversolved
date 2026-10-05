// BrepDiff predicates shared by the boolean and body-operation leaves.

import type { BrepDiff } from '../../types3d'

/**
 * Merge two BrepDiffs by concatenating every classification list.
 * Returns `b` when `a` is null (first cut in a loop).
 */
export function mergeBrepDiff(a: BrepDiff | null, b: BrepDiff): BrepDiff {
  if (a === null) return b
  return {
    new_faces: [...a.new_faces, ...b.new_faces],
    inherited_faces: [...a.inherited_faces, ...b.inherited_faces],
    new_edges: [...a.new_edges, ...b.new_edges],
    inherited_edges: [...a.inherited_edges, ...b.inherited_edges],
    modified_input_faces: [...a.modified_input_faces, ...b.modified_input_faces],
    deleted_input_faces: [...a.deleted_input_faces, ...b.deleted_input_faces],
    modified_input_edges: [...a.modified_input_edges, ...b.modified_input_edges],
    deleted_input_edges: [...a.deleted_input_edges, ...b.deleted_input_edges],
  }
}

/**
 * True if a BrepDiff has no geometry change (mirrors `_brep_diff_is_empty`).
 * A null diff returns false (it represents "not computed", not "empty").
 */
export function brepDiffIsEmpty(diff: BrepDiff | null): boolean {
  if (diff === null) return false
  return (
    diff.new_faces.length === 0 &&
    diff.deleted_input_faces.length === 0 &&
    diff.modified_input_faces.length === 0 &&
    diff.new_edges.length === 0 &&
    diff.deleted_input_edges.length === 0 &&
    diff.modified_input_edges.length === 0
  )
}
