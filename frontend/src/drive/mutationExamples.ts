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
  {
    mutation: {
      type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30],
      p0Ref: '@builtin_origin', dimensions: true,
    },
  },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Extrude', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
]

const FILLET_EDGES = [
  '?15,4,9,15,15,7,7;@u|e_24cea39158504826@ex1@body_ex1@sk1/eKPSVl164lTIlYEW@sk1/usUy8mnQpMYZgmKh@cls_xn@cls_zn:straightedge',
  '?15,4,9,15,15,7,7;@u|e_0690305d0af3e858@ex1@body_ex1@sk1/Xkck0RRPy6V4_iVJ@sk1/usUy8mnQpMYZgmKh@cls_xn@cls_zp:straightedge',
  '?15,4,9,15,15,7,7;@u|e_b3ae1e70492e31eb@ex1@body_ex1@sk1/FTWh9huZRvo1rGJ6@sk1/eKPSVl164lTIlYEW@cls_xp@cls_zn:straightedge',
  '?15,4,9,15,15,7,7;@u|e_8b99a2435cb5d089@ex1@body_ex1@sk1/Xkck0RRPy6V4_iVJ@sk1/FTWh9huZRvo1rGJ6@cls_xp@cls_zp:straightedge',
]

const FILLET_STEPS: ScriptStep[] = [
  ...BOX_STEPS,
  { mutation: { type: 'add_fillet', featureId: 'fi1', label: 'Fillet', edges: FILLET_EDGES, radius: 3 } },
]

const TAPERED_BLOCK_STEPS: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_top' } },
  {
    mutation: {
      type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [18, 18],
      p0Ref: '@builtin_origin', dimensions: true,
    },
  },
  {
    mutation: {
      type: 'add_extrude', featureId: 'ex1', label: 'Extrude',
      sketchQuery: '$sk1', distance: 10, taper: 15, operation: 'new',
    },
  },
]

// The projection path: the box's +Y face, one of its edges projected into the
// sketch, and a rectangle whose corner is anchored to that projected vertex.
// The sketch's numbers depend on the projection, not on the face centroid, so
// the law's normal face-sketch drift cannot reinterpret them.
const TOP_FACE = '?15,4,9,15,15,15,15,7;@u|u_42825f874782e937@ex1@body_ex1@sk1/FTWh9huZRvo1rGJ6@sk1/Xkck0RRPy6V4_iVJ@sk1/eKPSVl164lTIlYEW@sk1/usUy8mnQpMYZgmKh@cls_yp:flatface'
const TOP_EDGE = '?15,4,9,15,7,7;@u|e_37a33df87b666c99@ex1@body_ex1@sk1/Xkck0RRPy6V4_iVJ@cls_yp@cls_zp:straightedge'

const PROJECTION_STEPS: ScriptStep[] = [
  ...BOX_STEPS,
  { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Boss', plane: TOP_FACE } },
  {
    mutation: {
      type: 'add_projected_entity', featureId: 'sk2', kind: 'line',
      source: TOP_EDGE, entityId: 'pe1',
    },
  },
  {
    mutation: {
      type: 'add_rect', featureId: 'sk2', p0: [0, 0], p1: [20, 10],
      p0Ref: 'vertex:sk2:pe1:start', dimensions: true,
    },
  },
  {
    mutation: {
      type: 'add_extrude', featureId: 'ex2', label: 'Boss',
      sketchQuery: '$sk2', distance: 5, operation: 'add',
    },
  },
]

// The user's emboss workflow: a cylinder, a footprint on a plane in front of
// its curved wall, and `add` up to that wall with a +0.5 surface slab. Face 2 of
// the sorted cylinder is the lateral face (the two discs are flat, so they sort
// first); the real test pins the query and the volume.
const EMBOSS_ON_CYLINDER_STEPS: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Circle', plane: '@builtin_plane_front' } },
  {
    mutation: {
      type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 20],
      entityId: 'c1', dimensions: true,
    },
  },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk1', kind: 'coincident',
      targets: ['vertex:sk1:c1:center', '@builtin_origin'],
    },
  },
  {
    mutation: {
      type: 'add_extrude', featureId: 'ex1', label: 'Cylinder',
      sketchQuery: '$sk1', distance: 30, operation: 'new',
    },
  },
  { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Footprint', plane: '@builtin_plane_top' } },
  {
    mutation: {
      type: 'add_rect', featureId: 'sk2', p0: [-5, -25], p1: [5, -5],
      entityIds: ['r1', 'r2', 'r3', 'r4'], dimensions: true,
    },
  },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk2', kind: 'point_distance_x',
      targets: ['vertex:sk2:r1:start', '@builtin_origin'], value: 5, sign: 1,
    },
  },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk2', kind: 'point_distance_y',
      targets: ['vertex:sk2:r1:start', '@builtin_origin'], value: 25, sign: 1,
    },
  },
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
    name: 'projection',
    summary: 'A 20 x 10 boss on the box top, its corner anchored to a projected face edge: 13000 mm3.',
    steps: PROJECTION_STEPS,
  },
  {
    name: 'emboss-on-cylinder',
    summary: 'A 0.5 raised footprint on a 20 mm cylinder wall, up_to the curved face with up_to_start surface: 37800.157 mm3.',
    steps: EMBOSS_ON_CYLINDER_STEPS,
  },
]
