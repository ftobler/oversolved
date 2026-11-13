// @vitest-environment node
//
// The mutations whose handler reads a sketch's solved `initial` must flush
// before they run in a deferred script, or a one-call run and a one-step-per-
// call chain would read different geometry. A mutation that only writes
// geometry does not need it.

import { describe, it, expect } from 'vitest'
import { usesSettledSketchGeometry } from '../solveDependencies'
import type { PartDoc } from '@/types/cad'

describe('usesSettledSketchGeometry', () => {
  it('names every handler that reads the current sketch params', () => {
    for (const type of [
      'move_entity', 'move_vertex', 'move_vertex_with_constraint', 'resize_circle',
      'mirror_entities', 'apply_offset', 'fillet_corners', 'pattern_entities', 'insert_fit_point', 'set_fit_spline_handle',
    ]) {
      expect(usesSettledSketchGeometry({ type })).toBe(true)
    }
  })

  it('needs a flush for a dock handle on any mutation that can carry one', () => {
    expect(usesSettledSketchGeometry({ type: 'add_constraint', targets: ['dock:sk1:c_t'] })).toBe(true)
    expect(usesSettledSketchGeometry({
      type: 'add_entity_with_constraint', featureId: 'sk1',
      snapVertexId: 'dock:sk1:c_t', snapEntityRef: null,
    })).toBe(true)
    expect(usesSettledSketchGeometry({
      type: 'add_rect', featureId: 'sk1',
      p0: [0, 0], p1: [1, 1], p0Ref: 'dock:sk1:c_t',
    })).toBe(true)
    expect(usesSettledSketchGeometry({
      type: 'add_constraint',
      targets: ['entity:sk1:l1', 'vertex:sk1:l1:start'],
    })).toBe(false)
  })

  it('needs a flush for deleting a fit-spline point', () => {
    expect(usesSettledSketchGeometry({ type: 'delete', targets: ['vertex:sk1:sp:fit2'] })).toBe(true)
    expect(usesSettledSketchGeometry({ type: 'delete', targets: ['entity:sk1:l1'] })).toBe(false)
  })

  it('needs a flush for a face projection, which reads the last solved boundary', () => {
    expect(usesSettledSketchGeometry({
      type: 'add_projected_entity', featureId: 'sk1',
      source: '?9;@u|e_abcd:flatface',
    })).toBe(true)
    expect(usesSettledSketchGeometry({
      type: 'add_projected_entity', featureId: 'sk1', kind: 'line',
      source: '?9;@u|e_abcd:straightedge',
    })).toBe(false)
  })

  it('needs a flush for deleting a face projection, but not a map-less form', () => {
    const doc = {
      version: 7, kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [], initial: {},
        constraints: [
          { id: 'face', kind: 'projection', source: '?face', members: { 'u|e_aaaa': 'proj_face.aaaaaaaa' } },
          { id: 'empty', kind: 'projection', source: '?face2' },
          { id: 'edge', kind: 'projection', target: '$l1', source: '?edge;line' },
        ],
      }],
    } as unknown as PartDoc
    expect(usesSettledSketchGeometry({ type: 'delete', targets: ['constraint:sk1:face'] }, doc)).toBe(true)
    expect(usesSettledSketchGeometry({ type: 'delete', targets: ['constraint:sk1:empty'] }, doc)).toBe(false)
    expect(usesSettledSketchGeometry({ type: 'delete', targets: ['constraint:sk1:edge'] }, doc)).toBe(false)
    // Unvalidated JSON without targets is a refusal, not a throw.
    expect(usesSettledSketchGeometry({ type: 'delete' }, doc)).toBe(false)
  })

  it('leaves the writing mutations alone', () => {
    for (const step of [
      { type: 'add_rect', featureId: 'sk1' },
      { type: 'add_entity', featureId: 'sk1', kind: 'line' },
      { type: 'add_entity', featureId: 'sk1', kind: 'fit_spline' },
      { type: 'toggle_construction', targets: ['entity:sk1:l1'] },
      { type: 'add_extrude', featureId: 'ex1' },
    ]) {
      expect(usesSettledSketchGeometry(step)).toBe(false)
    }
    expect(usesSettledSketchGeometry(null)).toBe(false)
    expect(usesSettledSketchGeometry('not a step')).toBe(false)
  })
})
