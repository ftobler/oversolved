import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'

/**
 * The field a newly added feature arms first, so the user can start picking
 * without clicking the empty chip. The table is the per-kind choice of which
 * field to start on (an extrude starts on its sketch, a fillet on its edges);
 * the schema answers what that field names, so a part field arms as a part pick
 * and a panel that lists the document's parts knows its rows are pick targets.
 */
export type FirstPickField = { field: string; multi?: boolean; names?: 'body' }

const FIRST_PICK_FIELD: Record<string, { field: string; multi?: boolean }> = {
  plane: { field: 'plane' },
  extrude: { field: 'sketch', multi: true },
  revolve: { field: 'sketch', multi: true },
  sweep: { field: 'sketch', multi: true },
  wrap: { field: 'sketch' },
  fillet: { field: 'edges', multi: true },
  chamfer: { field: 'edges', multi: true },
  shell: { field: 'faces', multi: true },
  move_face: { field: 'faces', multi: true },
  delete_face: { field: 'faces', multi: true },
  hole: { field: 'sketch' },
  boolean: { field: 'target' },
  transform: { field: 'bodies', multi: true },
  mirror: { field: 'body' },
  split: { field: 'bodies', multi: true },
  delete_body: { field: 'bodies', multi: true },
  helix: { field: 'reference' },
}

export function firstPickField(kind: string): FirstPickField | undefined {
  const firstPick = FIRST_PICK_FIELD[kind]
  if (!firstPick) return undefined
  // A kind with no schema editor (the plane pick) keeps its field as it is; the
  // rest carry the schema's own flag rather than a second copy of it here.
  const definition = EDITOR_SCHEMAS[kind]?.fields.find(
    field => field.type === 'pick' && field.key === firstPick.field,
  )
  return {
    ...firstPick,
    names: definition?.type === 'pick' ? definition.names : undefined,
  }
}
