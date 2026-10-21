// The two scripts the first agent session built against the MCP server: a
// 40 x 30 box on the Top plane extruded 10 along +Y, and the same box with its
// four vertical (Y-parallel) edges filleted at radius 3. They live here, in a
// normal module, so the `mutations` tool serves them and the catalog tests run
// exactly the same steps through the real kernel.
//
// The edge queries are the deterministic `?body_ex1:edge:<index>` aliases the
// builder registers, not the longer `?` ancestry strings `select` mints for
// this box: a select query embeds the sketch entity ids that created the edge,
// and only a seeded journal makes those repeat. The indices are the ones
// `select {parallel:[0,1,0]}` returns for this box.

import type { ScriptStep } from '@/drive/scriptRunner'

export interface MutationExample {
  name: string
  summary: string
  steps: ScriptStep[]
}

const BOX_STEPS: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_top' } },
  { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 10 } },
]

const FILLET_STEPS: ScriptStep[] = [
  ...BOX_STEPS,
  { mutation: { type: 'add_fillet', featureId: 'fi1', label: 'Fillet' } },
  { mutation: { type: 'add_fillet_edge', featureId: 'fi1', edgeQuery: '?body_ex1:edge:1' } },
  { mutation: { type: 'add_fillet_edge', featureId: 'fi1', edgeQuery: '?body_ex1:edge:2' } },
  { mutation: { type: 'add_fillet_edge', featureId: 'fi1', edgeQuery: '?body_ex1:edge:7' } },
  { mutation: { type: 'add_fillet_edge', featureId: 'fi1', edgeQuery: '?body_ex1:edge:9' } },
  { mutation: { type: 'set_fillet_field', featureId: 'fi1', field: 'radius', value: 3 } },
]

export const MUTATION_EXAMPLES: readonly MutationExample[] = [
  {
    name: 'box',
    summary: 'A 40 x 30 sketch on Top extruded 10 along +Y: 12000 mm3.',
    steps: BOX_STEPS,
  },
  {
    name: 'filleted-box',
    summary: 'The box with its four Y-parallel edges filleted at radius 3: 11922.743 mm3.',
    steps: FILLET_STEPS,
  },
]
