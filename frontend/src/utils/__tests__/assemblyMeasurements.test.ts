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
      .toEqual(['distance 5.000 mm'])
  })

  it('measures the angle between two non-parallel planes', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
      f1: { kind: 'plane', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'f1']), entityMateRefs, anchors))
      .toEqual(['angle 90.0°', 'supplement 90.0°'])
  })

  it('measures a vertex to plane perpendicular distance', () => {
    const { entityMateRefs, anchors } = fixture({
      p0: { kind: 'point', point: [1, 2, 7], axis: [0, 0, 0] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    expect(computeAssemblyMeasurements(new Set(['p0', 'f0']), entityMateRefs, anchors))
      .toEqual(['distance 7.000 mm'])
  })

  it('measures the distance between two vertices and its delta legs', () => {
    const { entityMateRefs, anchors } = fixture({
      p0: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 0] },
      p1: { kind: 'point', point: [3, 4, 0], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['p0', 'p1']), entityMateRefs, anchors))
      .toEqual(['distance 5.000 mm', 'dx 3.000 mm', 'dy 4.000 mm', 'dz 0.000 mm'])
  })

  it('reads two coincident vertices as a zero distance with zero legs', () => {
    // The old assembly rule suppressed anything at or below 0.01; a zero is a
    // real answer to "how far apart are these" and the shared core states it.
    const { entityMateRefs, anchors } = fixture({
      p0: { kind: 'point', point: [1, 2, 3], axis: [0, 0, 0] },
      p1: { kind: 'point', point: [1, 2, 3], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['p0', 'p1']), entityMateRefs, anchors))
      .toEqual(['distance 0.000 mm', 'dx 0.000 mm', 'dy 0.000 mm', 'dz 0.000 mm'])
  })

  it('measures the angle between two edges and its supplement', () => {
    const { entityMateRefs, anchors } = fixture({
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 0] },
      e1: { kind: 'line', point: [0, 0, 0], axis: [0, 1, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['e0', 'e1']), entityMateRefs, anchors))
      .toEqual(['angle 90.0°', 'supplement 90.0°'])
  })

  it('measures the perpendicular distance between parallel edges', () => {
    const { entityMateRefs, anchors } = fixture({
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 0] },
      e1: { kind: 'line', point: [0, 4, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['e0', 'e1']), entityMateRefs, anchors))
      .toEqual(['distance 4.000 mm'])
  })

  it('measures coaxial circular edges as an axial distance', () => {
    const { entityMateRefs, anchors } = fixture({
      c0: { kind: 'circle', point: [0, 0, 0], axis: [0, 0, 1] },
      c1: { kind: 'circle', point: [0, 0, 10], axis: [0, 0, 1] },
    })
    // Two coaxial rims with no stated radii: the step along the axis is the
    // number, not the slanted centre distance.
    expect(computeAssemblyMeasurements(new Set(['c0', 'c1']), entityMateRefs, anchors))
      .toEqual(['axial distance 10.000 mm'])
  })

  it('measures a cylinder axis against a plane', () => {
    const { entityMateRefs, anchors } = fixture({
      cy0: { kind: 'cylinder', point: [0, 0, 3], axis: [1, 0, 0] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    // The axis lies in the plane's direction (perpendicular to its normal), so
    // the pair reads the axis-to-plane distance.
    expect(computeAssemblyMeasurements(new Set(['cy0', 'f0']), entityMateRefs, anchors))
      .toEqual(['axis distance 3.000 mm'])
  })

  it('measures a torus axis against a cylinder axis', () => {
    const { entityMateRefs, anchors } = fixture({
      t0: { kind: 'torus', point: [0, 7, 0], axis: [0, 0, 1] },
      cy0: { kind: 'cylinder', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    expect(computeAssemblyMeasurements(new Set(['t0', 'cy0']), entityMateRefs, anchors))
      .toEqual(['axis distance 7.000 mm'])
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
      .toEqual(['distance 5.000 mm'])
  })

  it('measures an edge parallel to a plane by its perpendicular distance', () => {
    const { entityMateRefs, anchors } = fixture({
      e0: { kind: 'line', point: [0, 0, 3], axis: [1, 0, 0] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    // Direction perpendicular to the normal means the edge never pierces the plane.
    expect(computeAssemblyMeasurements(new Set(['e0', 'f0']), entityMateRefs, anchors))
      .toEqual(['distance 3.000 mm'])
  })

  it('measures the angle between an edge and a plane it meets', () => {
    const { entityMateRefs, anchors } = fixture({
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 1] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
    })
    // 45 deg between the unit direction and the normal reports the 45 deg it
    // makes with the plane, not the 45 deg against the normal.
    expect(computeAssemblyMeasurements(new Set(['e0', 'f0']), entityMateRefs, anchors))
      .toEqual(['angle 45.0°', 'supplement 135.0°'])
  })

  it('measures a sphere anchor as its centre point', () => {
    const { entityMateRefs, anchors } = fixture({
      s0: { kind: 'sphere', point: [2, 0, 0], axis: [0, 0, 0] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['s0', 'f0']), entityMateRefs, anchors))
      .toEqual(['distance 2.000 mm'])
  })

  it('reads nothing when more than two entities are selected', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
      f1: { kind: 'plane', point: [0, 0, 5], axis: [0, 0, 1] },
      p0: { kind: 'point', point: [100, 0, 0], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'f1', 'p0']), entityMateRefs, anchors))
      .toEqual([])
  })

  it('measures a plane to a point regardless of selection order', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
      p0: { kind: 'point', point: [1, 2, 7], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'p0']), entityMateRefs, anchors))
      .toEqual(['distance 7.000 mm'])
    expect(computeAssemblyMeasurements(new Set(['p0', 'f0']), entityMateRefs, anchors))
      .toEqual(['distance 7.000 mm'])
  })

  it('measures a plane to an edge regardless of selection order', () => {
    const { entityMateRefs, anchors } = fixture({
      f0: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1] },
      e0: { kind: 'line', point: [0, 0, 3], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['f0', 'e0']), entityMateRefs, anchors))
      .toEqual(['distance 3.000 mm'])
    expect(computeAssemblyMeasurements(new Set(['e0', 'f0']), entityMateRefs, anchors))
      .toEqual(['distance 3.000 mm'])
  })

  it('measures a point to an edge regardless of selection order', () => {
    const { entityMateRefs, anchors } = fixture({
      p0: { kind: 'point', point: [0, 0, 5], axis: [0, 0, 0] },
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['e0', 'p0']), entityMateRefs, anchors))
      .toEqual(['distance 5.000 mm'])
  })

  it('measures a circle to a point by center distance and its delta legs, either way round', () => {
    const { entityMateRefs, anchors } = fixture({
      c0: { kind: 'circle', point: [0, 0, 0], axis: [0, 0, 1] },
      p0: { kind: 'point', point: [3, 4, 0], axis: [0, 0, 0] },
    })
    expect(computeAssemblyMeasurements(new Set(['c0', 'p0']), entityMateRefs, anchors))
      .toEqual(['center distance 5.000 mm', 'dx 3.000 mm', 'dy 4.000 mm', 'dz 0.000 mm'])
    expect(computeAssemblyMeasurements(new Set(['p0', 'c0']), entityMateRefs, anchors))
      .toEqual(['center distance 5.000 mm', 'dx 3.000 mm', 'dy 4.000 mm', 'dz 0.000 mm'])
  })

  it('measures a circle to a line by the centre-to-line distance', () => {
    const { entityMateRefs, anchors } = fixture({
      c0: { kind: 'circle', point: [0, 3, 0], axis: [0, 0, 1] },
      e0: { kind: 'line', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    // The pair table reads a line against a circle by its centre, the same as
    // the part editor does; only a cylinder axis gets the axis-pair rules.
    expect(computeAssemblyMeasurements(new Set(['c0', 'e0']), entityMateRefs, anchors))
      .toEqual(['center distance 3.000 mm'])
  })

  it('measures a circle standing perpendicular to a plane by centre-to-face distance', () => {
    const { entityMateRefs, anchors } = fixture({
      c0: { kind: 'circle', point: [3, 0, 0], axis: [0, 0, 1] },
      f0: { kind: 'plane', point: [0, 0, 0], axis: [1, 0, 0] },
    })
    // The circle's axis lies along the plane, so the useful number is how far
    // its centre sits from the face, not the 90 degree angle between them.
    expect(computeAssemblyMeasurements(new Set(['c0', 'f0']), entityMateRefs, anchors))
      .toEqual(['distance 3.000 mm'])
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
