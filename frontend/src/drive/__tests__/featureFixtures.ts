// Scripts shared by the drive suites that pin per-feature solve outcomes. They
// rebuild the reported document at its smallest: a plate, a boss built from a
// circle, and a hole whose whole-sketch pick names a sketch that is no drill
// site. The second script drills a point that lies outside the body, the
// kernel's "ok with a solver_warning" case.
//
// Every sketch here is dimensioned and anchored, per the sketch constraint law:
// these scripts pin feature outcomes, so an underconstrained warning row would
// blur the count each test reads.

import type { ScriptStep } from '@/drive/scriptRunner'

export const HOLE_ON_LINE_SKETCH: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Plate', plane: '@builtin_plane_top' } },
  {
    mutation: {
      type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [7.5, 7.5],
      centerRef: '@builtin_origin', dimensions: true,
    },
  },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Plate', sketchQuery: '$sk1', distance: 2, operation: 'new' } },
  {
    mutation: {
      type: 'add_plane',
      featureId: 'pl2',
      label: 'Boss base',
      definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 2 },
    },
  },
  { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Boss', plane: '@pl2' } },
  { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [0, 0, 4], entityId: 'c1', dimensions: true } },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk2', kind: 'coincident',
      targets: ['vertex:sk2:c1:center', '@builtin_origin'],
    },
  },
  { mutation: { type: 'add_extrude', featureId: 'ex2', label: 'Boss', sketchQuery: '$sk2', distance: 10 } },
  { mutation: { type: 'add_sketch', featureId: 'sk3', label: 'Bore centres', plane: '@pl2' } },
  { mutation: { type: 'add_entity', featureId: 'sk3', kind: 'line', params: [-5, 0, 5, 0], entityId: 'l1', dimensions: true } },
  { mutation: { type: 'add_constraint', featureId: 'sk3', kind: 'horizontal', targets: ['entity:sk3:l1'] } },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk3', kind: 'point_distance_x',
      targets: ['vertex:sk3:l1:start', '@builtin_origin'], value: 5, sign: 1,
    },
  },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk3', kind: 'point_distance_y',
      targets: ['vertex:sk3:l1:start', '@builtin_origin'], value: 0, sign: 1,
    },
  },
  { mutation: { type: 'add_hole', featureId: 'h1', label: 'Bore' } },
  { mutation: { type: 'set_hole_field', featureId: 'h1', field: 'sketch', value: '@sk3' } },
  { mutation: { type: 'set_hole_field', featureId: 'h1', field: 'diameter', value: 6 } },
  { mutation: { type: 'set_hole_field', featureId: 'h1', field: 'depth_mode', value: 'through_all' } },
  { mutation: { type: 'set_hole_field', featureId: 'h1', field: 'depth', value: 20 } },
]

export const HOLE_ALL_SITES_MISS: ScriptStep[] = [
  { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Plate', plane: '@builtin_plane_top' } },
  {
    mutation: {
      type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [10, 10],
      centerRef: '@builtin_origin', dimensions: true,
    },
  },
  { mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Plate', sketchQuery: '$sk1', distance: 2, operation: 'new' } },
  { mutation: { type: 'add_sketch', featureId: 'sk2', label: 'Bore centres', plane: '@builtin_plane_top' } },
  // Far outside the plate, so the site has geometry but removes no material.
  { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'point', params: [100, 100], entityId: 'p1' } },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk2', kind: 'point_distance_x',
      targets: ['vertex:sk2:p1:xy', '@builtin_origin'], value: 100, sign: -1,
    },
  },
  {
    mutation: {
      type: 'add_constraint', featureId: 'sk2', kind: 'point_distance_y',
      targets: ['vertex:sk2:p1:xy', '@builtin_origin'], value: 100, sign: -1,
    },
  },
  { mutation: { type: 'add_hole', featureId: 'h1', label: 'Bore' } },
  { mutation: { type: 'set_hole_field', featureId: 'h1', field: 'sketch', value: '@sk2' } },
  { mutation: { type: 'set_hole_field', featureId: 'h1', field: 'diameter', value: 4 } },
  { mutation: { type: 'set_hole_field', featureId: 'h1', field: 'depth', value: 5 } },
]
