import { describe, it, expect } from 'vitest'
import { computeAssemblyMeasurements } from '@/utils/assemblyMeasurements'
import type { AnchorTable } from '@/utils/anchorGizmos'
import type { EntityMateRefs } from '@/utils/anchorCandidates'
import type { AnchorPose } from '@/kernel/partBundle'

// A tiny fixture: two parts, each entity key maps to one anchor id, and the
// anchor table gives that id a pose. The keys are opaque here; only the join
// through entityMateRefs -> anchors matters.
function fixture(anchorsByKey: Record<string, AnchorPose>): {
  entityMateRefs: EntityMateRefs
  anchors: AnchorTable
} {
  const entityMateRefs: EntityMateRefs = {}
  const partAnchors: Record<string, AnchorPose> = {}
  for (const [key, pose] of Object.entries(anchorsByKey)) {
    const anchorId = `a_${key}`
    entityMateRefs[key] = [{ part: 'P', anchor: anchorId }]
    partAnchors[anchorId] = pose
  }
  return { entityMateRefs, anchors: { P: partAnchors } }
}

describe('computeAssemblyMeasurements', () => {
  it('returns nothing for a single entity', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0']), entityMateRefs, anchors)).toEqual([])
  })

  it('measures the distance between two parallel planes', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
      f1: { kind: 'plane', point: [0, 0, 5], axis: [0, 0, 1] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'f1']), entityMateRefs, anchors))
      .toEqual(['plane distance: 5.00 mm'])
  })

  it('measures the angle between two non-parallel planes', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
      f1: { kind: 'plane', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'f1']), entityMateRefs, anchors))
      .toEqual(['plane angle: 90.00°'])
  })

  it('measures a vertex to plane perpendicular distance', () => {
    const { entityMateRefs, anchors } = fixture({
      p0: { kind: 'point', point: [1, 2, 7], axis: [0, 0, 0] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    expect(computeAssemblyMeasurements(new Set(['p0', 'f0']), entityMateRefs, anchors))
      .toEqual(['plane distance: 7.00 mm'])
  })

  it('measures the distance between two vertices', () => {
    const { entityMateRefs, anchors } = fixture({
      p0: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 0] },
      p1: { kind: 'point', point: [3, 4, 0], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['p0', 'p1']), entityMateRefs, anchors))
      .toEqual(['dist: 5.00 mm'])
  })

  it('measures the angle between two edges', () => {
    const { entityMateRefs, anchors } = fixture({
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 0] },
      e1: { kind: 'line', point: [0, 0, 0], axis: [0, 1, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['e0', 'e1']), entityMateRefs, anchors))
      .toEqual(['edge angle: 90.00°'])
  })

  it('measures the perpendicular distance between parallel edges', () => {
    const { entityMateRefs, anchors } = fixture({
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 0] },
      e1: { kind: 'line', point: [0, 4, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['e0', 'e1']), entityMateRefs, anchors))
      .toEqual(['parallel edges, distance: 4.00 mm'])
  })

  it('measures center distance between two circular edges', () => {
    const { entityMateRefs, anchors } = fixture({
      c0: { kind: 'circle', point: [0, 0, 0], axis: [0, 0, 1] },
      c1: { kind: 'circle', point: [0, 0, 10], axis: [0, 0, 1] },
    })
    expect(computeAssemblyMeasurements(new Set(['c0', 'c1']), entityMateRefs, anchors))
      .toEqual(['center dist: 10.00 mm'])
  })

  it('ignores an entity with no matable anchor', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    // 'ghost' has no entry in entityMateRefs, so it resolves to nothing.
    expect(computeAssemblyMeasurements(new Set(['f0', 'ghost']), entityMateRefs, anchors)).toEqual([])
  })

  it('ignores an entity whose anchor reference is no longer in the table', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    // A stale ref names an anchor id the solved table no longer carries.
    entityMateRefs.ghost = [{ part: 'P', anchor: 'a_ghost' }]
    expect(computeAssemblyMeasurements(new Set(['ghost', 'f0']), entityMateRefs, anchors)).toEqual([])
  })

  it('measures the perpendicular distance from a point to an edge', () => {
    const { entityMateRefs, anchors } = fixture({
      p0: { kind: 'point', point: [0, 0, 5], axis: [0, 0, 0] },
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['p0', 'e0']), entityMateRefs, anchors))
      .toEqual(['point-edge distance: 5.00 mm'])
  })

  it('measures an edge parallel to a plane by its perpendicular distance', () => {
    const { entityMateRefs, anchors } = fixture({
      e0: { kind: 'line', point: [0, 0, 3], axis: [1, 0, 0] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    // Direction perpendicular to the normal means the edge never pierces the plane.
    expect(computeAssemblyMeasurements(new Set(['e0', 'f0']), entityMateRefs, anchors))
      .toEqual(['plane distance: 3.00 mm'])
  })

  it('measures the angle between an edge and a plane it meets', () => {
    const { entityMateRefs, anchors } = fixture({
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 1] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    // 45 deg between the unit direction and the normal reports the 45 deg it
    // makes with the plane, not the 45 deg against the normal.
    expect(computeAssemblyMeasurements(new Set(['e0', 'f0']), entityMateRefs, anchors))
      .toEqual(['line-plane angle: 45.00°'])
  })

  it('reports nothing for two coincident points', () => {
    const { entityMateRefs, anchors } = fixture({
      p0: { kind: 'point', point: [1, 2, 3], axis: [0, 0, 0] },
      p1: { kind: 'point', point: [1, 2, 3], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['p0', 'p1']), entityMateRefs, anchors)).toEqual([])
  })

  it('measures a sphere anchor as its centre point', () => {
    const { entityMateRefs, anchors } = fixture({
      s0: { kind: 'sphere', point: [2, 0, 0], axis: [0, 0, 0] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['s0', 'f0']), entityMateRefs, anchors))
      .toEqual(['plane distance: 2.00 mm'])
  })

  it('measures only the first two resolvable entities when more are selected', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
      f1: { kind: 'plane', point: [0, 0, 5], axis: [0, 0, 1] },
      p0: { kind: 'point', point: [100, 0, 0], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'f1', 'p0']), entityMateRefs, anchors))
      .toEqual(['plane distance: 5.00 mm'])
  })

  it('measures a plane to a point regardless of selection order', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
      p0: { kind: 'point', point: [1, 2, 7], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'p0']), entityMateRefs, anchors))
      .toEqual(['plane distance: 7.00 mm'])
    expect(computeAssemblyMeasurements(new Set(['p0', 'f0']), entityMateRefs, anchors))
      .toEqual(['plane distance: 7.00 mm'])
  })

  it('measures a plane to an edge regardless of selection order', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
      e0: { kind: 'line', point: [0, 0, 3], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'e0']), entityMateRefs, anchors))
      .toEqual(['plane distance: 3.00 mm'])
    expect(computeAssemblyMeasurements(new Set(['e0', 'f0']), entityMateRefs, anchors))
      .toEqual(['plane distance: 3.00 mm'])
  })

  it('measures a point to an edge regardless of selection order', () => {
    const { entityMateRefs, anchors } = fixture({
      p0: { kind: 'point', point: [0, 0, 5], axis: [0, 0, 0] },
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['e0', 'p0']), entityMateRefs, anchors))
      .toEqual(['point-edge distance: 5.00 mm'])
  })

  it('measures a circle to a point by center distance, either way round', () => {
    const { entityMateRefs, anchors } = fixture({
      c0: { kind: 'circle', point: [0, 0, 0], axis: [0, 0, 1] },
      p0: { kind: 'point', point: [3, 4, 0], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['c0', 'p0']), entityMateRefs, anchors))
      .toEqual(['center dist: 5.00 mm'])
    expect(computeAssemblyMeasurements(new Set(['p0', 'c0']), entityMateRefs, anchors))
      .toEqual(['center dist: 5.00 mm'])
  })

  it('measures a circle to an edge by the axis pair, not by center distance', () => {
    const { entityMateRefs, anchors } = fixture({
      c0: { kind: 'circle', point: [0, 0, 0], axis: [0, 0, 1] },
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['c0', 'e0']), entityMateRefs, anchors))
      .toEqual(['edge angle: 90.00°'])
  })

  it('measures a circle to a plane by the line-plane rule', () => {
    const { entityMateRefs, anchors } = fixture({
      c0: { kind: 'circle', point: [3, 0, 0], axis: [0, 0, 1] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['c0', 'f0']), entityMateRefs, anchors))
      .toEqual(['plane distance: 3.00 mm'])
  })

  it('treats an anchor whose direction cannot be normalized as unmeasurable', () => {
    // A zero-length axis is not a plane normal, edge direction or circle axis,
    // so the primitive drops out instead of producing a NaN measurement.
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 0] },
      e0: { kind: 'line', point: [0, 0, 0], axis: [0, 0, 0] },
      c0: { kind: 'circle', point: [0, 0, 0], axis: [0, 0, 0] },
      p0: { kind: 'point', point: [1, 0, 0], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'e0']), entityMateRefs, anchors)).toEqual([])
    expect(computeAssemblyMeasurements(new Set(['c0', 'p0']), entityMateRefs, anchors)).toEqual([])
  })

  it('treats an unrecognized anchor kind as unmeasurable', () => {
    const { entityMateRefs, anchors } = fixture({
      x0: { kind: 'blob' as unknown as AnchorPose['kind'], point: [0, 0, 0], axis: [0, 0, 1] },
      p0: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['x0', 'p0']), entityMateRefs, anchors)).toEqual([])
  })
})
