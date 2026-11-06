// @vitest-environment node
//
// The mutations whose handler reads a sketch's solved `initial` must flush
// before they run in a deferred script, or a one-call run and a one-step-per-
// call chain would read different geometry. A mutation that only writes
// geometry does not need it.

import { describe, it, expect } from 'vitest'
import { usesSettledSketchGeometry } from '../solveDependencies'

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
