// Feature kinds that expose an edit action in the tree, keyed to the word used
// in the edit tooltip. `sketch` is the lone exception: it edits via
// onEnterEditSketch rather than onEnterEditFeature. This is the single source
// for both the placeholder slot and the tree's double-click gate, so the two
// cannot drift. The OK/Cancel pair of an open edit is not here: it lives in
// FeatureEditPanel, the panel the tree row no longer carries.
export const EDIT_LABELS: Record<string, string> = {
  sketch: 'sketch',
  plane: 'plane',
  extrude: 'extrude',
  revolve: 'revolve',
  sweep: 'sweep',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  move_face: 'move face',
  delete_face: 'delete face',
  boolean: 'boolean',
  array: 'array',
  circular_array: 'circular array',
  delete_body: 'delete body',
  hole: 'hole',
  transform: 'transform',
  mirror: 'mirror',
  variable: 'variable',
  helix: 'helix',
}

/** Whether a feature kind opens in the feature editor (or sketch editor) rather
 *  than being a non-editable row. `sketch` is included; the caller branches on
 *  it first. */
export function isEditableFeatureKind(kind: string | undefined): boolean {
  // Own-property check, not `in`: the latter walks the prototype chain and would
  // treat 'constructor'/'toString' as editable kinds.
  return kind !== undefined && Object.prototype.hasOwnProperty.call(EDIT_LABELS, kind)
}
