// Feature kinds that expose edit (and, while editing, OK/Cancel) buttons, keyed
// to the word used in the edit tooltip. `sketch` is the lone exception: it edits
// via onEnterEditSketch rather than onEnterEditFeature. This is the single source
// for both the placeholder slot and the tree's double-click gate, so the two
// cannot drift.
export const EDIT_LABELS: Record<string, string> = {
  sketch: 'sketch',
  plane: 'plane',
  extrude: 'extrude',
  revolve: 'revolve',
  sweep: 'sweep',
  fillet: 'fillet',
  chamfer: 'chamfer',
  boolean: 'boolean',
  array: 'array',
  circular_array: 'circular array',
  delete_body: 'delete body',
  hole: 'hole',
  transform: 'transform',
  mirror: 'mirror',
  variable: 'variable',
}

/** Whether a feature kind opens in the feature editor (or sketch editor) rather
 *  than being a non-editable row. `sketch` is included; the caller branches on
 *  it first. */
export function isEditableFeatureKind(kind: string | undefined): boolean {
  // Own-property check, not `in`: the latter walks the prototype chain and would
  // treat 'constructor'/'toString' as editable kinds.
  return kind !== undefined && Object.prototype.hasOwnProperty.call(EDIT_LABELS, kind)
}
