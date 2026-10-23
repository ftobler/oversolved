// The two scripts the first agent session built against the MCP server: a
// 40 x 30 box on the Top plane extruded 10 along +Y, and the same box with its
// four vertical (Y-parallel) edges filleted at radius 3. They live here, in a
// normal module, so the `mutations` tool serves them and the catalog tests run
// exactly the same steps through the real kernel.
//
// The edge queries are the ancestry strings `select` mints for this box: run as
// `select {kind:'edge', where:{parallel:[0,1,0]}}` on the document BOX_STEPS
// builds, they name its four Y-parallel edges (Y is up). They embed the sketch
// entity ids add_rect minted, and those repeat because a drive run seeds each
// step from the document before it and the step's own content
// (drive/seededIds.ts), so the same fresh document and steps mint the same ids
// regardless of chunking. A ScriptStep is a command id or a
// mutation, so it cannot express a `select` step: the example carries the
// queries that step produced instead of the step itself.

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

const FILLET_EDGES = [
  '?15,4,9,15,15,7,7;@u|e_697ad2ebeead097b@ex1@body_ex1@sk1/JYbi_lky54WhmLXO@sk1/t0Y0HmwoxeqOCaem@cls_xn@cls_zn:straightedge',
  '?15,4,9,15,15,7,7;@u|e_3b61715990c341be@ex1@body_ex1@sk1/ABKeovVyZqFFRLRD@sk1/t0Y0HmwoxeqOCaem@cls_xn@cls_zp:straightedge',
  '?15,4,9,15,15,7,7;@u|e_41f1f9b6b9d4658a@ex1@body_ex1@sk1/1PBFlZzALgDN7VwE@sk1/JYbi_lky54WhmLXO@cls_xp@cls_zn:straightedge',
  '?15,4,9,15,15,7,7;@u|e_b955e8635ace8599@ex1@body_ex1@sk1/ABKeovVyZqFFRLRD@sk1/1PBFlZzALgDN7VwE@cls_xp@cls_zp:straightedge',
]

const FILLET_STEPS: ScriptStep[] = [
  ...BOX_STEPS,
  { mutation: { type: 'add_fillet', featureId: 'fi1', label: 'Fillet', edges: FILLET_EDGES, radius: 3 } },
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
