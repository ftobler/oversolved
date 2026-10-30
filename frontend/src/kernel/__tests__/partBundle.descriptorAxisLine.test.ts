// Descriptor matching for the axial kinds. A stored MateAnchorDescriptor point
// is a position captured at pick time, and for cylinder/cone/torus anchors that
// position has moved: from the surface frame's origin (an end of the face, or
// outside it) to the face's own axial midpoint. Matching therefore measures the
// perpendicular distance to the candidate's axis LINE first and the axial
// offset second, so a descriptor written anywhere on the face's axis still
// re-finds that face after the point moved.

import { describe, it, expect } from 'vitest'
import { anchorByDescriptor, anchorIdByDescriptor, type Anchor, type AnchorKind, type AnchorMatchInput } from '../partBundle'
import type { MateAnchorDescriptor } from '../../types/cad'

const descriptor = (over: Partial<MateAnchorDescriptor>): MateAnchorDescriptor => ({
  geom_hash: '@gdf|lost', kind: 'cylinder', created_by: 'ex1', point: [0, 0, 0],
  ...over,
})

describe('anchorIdByDescriptor: axial kinds match by axis line', () => {
  // A face whose axis is the world Z line through the origin, anchored at its
  // midpoint z = 5 (the face spans z 0..10).
  const onAxis: Anchor = {
    kind: 'cylinder', point: [0, 0, 5], axis: [0, 0, 1], geom_hash: '@gdf|a', created_by: 'ex1',
  }
  // A taller sibling on a parallel axis 6 away, whose midpoint z = 15 is the
  // 3D-nearest candidate to a descriptor written at z = 20.
  const sibling: Anchor = {
    kind: 'cylinder', point: [6, 0, 15], axis: [0, 0, 1], geom_hash: '@gdf|b', created_by: 'ex1',
  }

  const AXIAL_KINDS: AnchorKind[] = ['cylinder', 'cone', 'torus']
  for (const kind of AXIAL_KINDS) {
    it(`a ${kind} descriptor at the end of its axis re-finds its own face, not the 3D-nearest sibling`, () => {
      const anchors: Record<string, Anchor> = {
        onAxis: { ...onAxis, kind },
        sibling: { ...sibling, kind },
      }
      // Point distance ranks the sibling first (61 vs 225): it would rebind the
      // ref onto a face on another axis. The perpendicular distance to the
      // candidate's own axis ranks the descriptor at 0 from the axis it was
      // captured on, and that face wins.
      expect(anchorIdByDescriptor(anchors, descriptor({ kind, point: [0, 0, 20] }))).toBe('onAxis')
    })
  }

  it('coaxial faces tie on the perpendicular key and split on the axial offset', () => {
    const anchors: Record<string, Anchor> = {
      lower: { kind: 'cylinder', point: [0, 0, 2], axis: [0, 0, 1], geom_hash: '@gdf|low', created_by: 'ex1' },
      upper: { kind: 'cylinder', point: [0, 0, 8], axis: [0, 0, 1], geom_hash: '@gdf|up', created_by: 'ex1' },
    }
    // Both faces share one axis, so the perpendicular key cannot separate them
    // and the axial offset does, instead of the flat axis-only match refusing.
    expect(anchorIdByDescriptor(anchors, descriptor({ point: [0, 0, 0] }))).toBe('lower')
    expect(anchorIdByDescriptor(anchors, descriptor({ point: [0, 0, 12] }))).toBe('upper')
  })

  it('a sphere still matches by centre distance, never by its placeholder axis', () => {
    // Sphere anchors carry a placeholder [0, 0, 1] axis, not geometry. Read as a
    // line it would pass through the descriptor for the far sphere and wrongly
    // win; the centre distance ranks the near one first (1 vs 50).
    const anchors: Record<string, Anchor> = {
      far: { kind: 'sphere', point: [0, 0, 50], axis: [0, 0, 1], geom_hash: '@gdf|far', created_by: 'rev1' },
      near: { kind: 'sphere', point: [1, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|near', created_by: 'rev1' },
    }
    expect(anchorIdByDescriptor(anchors, descriptor({ kind: 'sphere', created_by: 'rev1', point: [0, 0, 0] }))).toBe('near')
  })

  it('a candidate with no axis (a stored descriptor table) falls back to point distance', () => {
    // The gizmo path resolves against MateAnchorDescriptors, which carry no
    // axis: display matching stays the point-nearest answer it always was.
    const anchors: Record<string, AnchorMatchInput> = {
      onAxis: { geom_hash: '@gdf|a', kind: 'cylinder', created_by: 'ex1', point: [0, 0, 5] },
      sibling: { geom_hash: '@gdf|b', kind: 'cylinder', created_by: 'ex1', point: [6, 0, 15] },
    }
    expect(anchorIdByDescriptor(anchors, descriptor({ point: [0, 0, 20] }))).toBe('sibling')
  })

  it('a plane keeps its point-distance match, axis or no axis', () => {
    const anchors: Record<string, Anchor> = {
      near: { kind: 'plane', point: [1, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|near', created_by: 'ex1' },
      far: { kind: 'plane', point: [10, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|far', created_by: 'ex1' },
    }
    expect(anchorByDescriptor(anchors, descriptor({ kind: 'plane', point: [0, 0, 0] }))).toBe(anchors.near)
  })

  it('two equidistant axial candidates refuse instead of guessing (fail-safe)', () => {
    const anchors: Record<string, Anchor> = {
      plus: { kind: 'cylinder', point: [1, 0, 0], axis: [1, 0, 0], geom_hash: '@gdf|plus', created_by: 'ex1' },
      minus: { kind: 'cylinder', point: [-1, 0, 0], axis: [1, 0, 0], geom_hash: '@gdf|minus', created_by: 'ex1' },
    }
    // The descriptor sits midway along the shared axis: both perpendicular
    // keys are 1 and both axial offsets are 0.
    expect(anchorIdByDescriptor(anchors, descriptor({ point: [0, 0, 0] }))).toBeUndefined()
  })

  it('a gone @u| identity still refuses rather than rebinding by axis', () => {
    const anchors: Record<string, Anchor> = {
      onAxis: { kind: 'cylinder', point: [0, 0, 5], axis: [0, 0, 1], geom_hash: '@gdf|a', created_by: 'ex1' },
    }
    expect(anchorIdByDescriptor(anchors, descriptor({ geom_hash: '@u|gone', point: [0, 0, 5] }))).toBeUndefined()
  })
})
