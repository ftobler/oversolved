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
// step from the authored document before it and the step's own content
// (drive/seededIds.ts), so the same fresh document and steps mint the same ids
// regardless of chunking or how many solves the run defers. A ScriptStep is a
// command id or a mutation, so it cannot express a `select` step: the example
// carries the queries that step produced instead of the step itself.

import type { ScriptStep } from '@/drive/scriptRunner'

export interface MutationExample {
  name: string
  summary: string
  steps: ScriptStep[]
}

const BOX_STEPS: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_top' } },
  { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
]

const FILLET_EDGES = [
  '?15,4,9,15,15,7,7;@u|e_6ddfceb870f533ac@ex1@body_ex1@sk1/wpDmL7SEsv-KsSIG@sk1/psisuKhJcA9qlM7R@cls_xn@cls_zn:straightedge',
  '?15,4,9,15,15,7,7;@u|e_9ba9c623b91560c8@ex1@body_ex1@sk1/AtLTm0UUpgaCvFNX@sk1/psisuKhJcA9qlM7R@cls_xn@cls_zp:straightedge',
  '?15,4,9,15,15,7,7;@u|e_a9370bedf7a8472f@ex1@body_ex1@sk1/t9jRiDKgS8t4ZLOW@sk1/wpDmL7SEsv-KsSIG@cls_xp@cls_zn:straightedge',
  '?15,4,9,15,15,7,7;@u|e_4e92a62a1bdae811@ex1@body_ex1@sk1/AtLTm0UUpgaCvFNX@sk1/t9jRiDKgS8t4ZLOW@cls_xp@cls_zp:straightedge',
]

const FILLET_STEPS: ScriptStep[] = [
  ...BOX_STEPS,
  { mutation: { type: 'add_fillet', featureId: 'fi1', label: 'Fillet', edges: FILLET_EDGES, radius: 3 } },
]

const TAPERED_BLOCK_STEPS: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_top' } },
  { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [18, 18] } },
  {
    mutation: {
      type: 'add_extrude', featureId: 'ex1', label: 'Extrude',
      sketchQuery: '$sk1', distance: 10, taper: 15, operation: 'new',
    },
  },
]

// The user's emboss workflow: a cylinder, a footprint on a plane in front of
// its curved wall, and `add` up to that wall with a +0.5 surface slab. Face 2 of
// the sorted cylinder is the lateral face (the two discs are flat, so they sort
// first); the real test pins the query and the volume.
const EMBOSS_ON_CYLINDER_STEPS: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Circle', plane: '@builtin_plane_front' } },
  { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 20] } },
  {
    mutation: {
      type: 'add_extrude', featureId: 'ex1', label: 'Cylinder',
      sketchQuery: '$sk1', distance: 30, operation: 'new',
    },
  },
  { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Footprint', plane: '@builtin_plane_top' } },
  { mutation: { type: 'add_rect', featureId: 'sk2', p0: [-5, -25], p1: [5, -5] } },
  {
    mutation: {
      type: 'add_extrude', featureId: 'ex2', label: 'Emboss',
      sketchQuery: '$sk2', distance: 1, operation: 'add', termination: 'up_to',
      up_to: '@body_ex1/face/2', up_to_start: 'surface', up_to_offset: 0.5,
    },
  },
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
  {
    name: 'tapered-block',
    summary: 'An 18 x 18 sketch on Top extruded 10 with taper 15: 2371.112 mm3.',
    steps: TAPERED_BLOCK_STEPS,
  },
  {
    name: 'emboss-on-cylinder',
    summary: 'A 0.5 raised footprint on a 20 mm cylinder wall, up_to the curved face with up_to_start surface: 37800.157 mm3.',
    steps: EMBOSS_ON_CYLINDER_STEPS,
  },
]
