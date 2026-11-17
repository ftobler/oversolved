import { describe, it, expect } from 'vitest'
import type { BodyResult, Sketch } from '@/types/cad'
import { measureSelection } from '@/utils/measure/measureSelection'
import type { SketchFrame } from '@/utils/measure/adapters/sketch'

const FRONT: SketchFrame = {
  origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
}
const TOP: SketchFrame = {
  origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0],
}

const flat: Sketch = {
  L1: { start: [0, 0], end: [10, 0] },
}

const body: BodyResult = {
  id: 'body_1',
  created_by: 'ex',
  modified_by: [],
  edges: [{ kind: 'line', start: [0, 5, 0], end: [10, 5, 0] }],
  edge_queries: ['?e1'],
  vertices: [[0, 0, 0]],
  vertex_queries: ['?v0'],
  mesh: {
    vertices: [], faces: [],
    face_data: [
      {
        centroid: [24, 5, 15], normal: [1, 0, 0], surface_type: 'cylinderface',
        surface_frame: { axis: [0, 1, 0], origin: [20, 0, 15], radius: 4 },
      },
    ],
    face_queries: ['?hole'],
  },
}

const solveResults = {
  skTop: { solved: { L1: { start: [0, 0], end: [10, 0] } }, plane: TOP },
  builtin_plane_top: { plane: FRONT },
}

const ctx = { solveResults, bodies: { body_1: body } }

describe('measureSelection: mixed picks keep both sides (defect 1)', () => {
  it('measures a datum plane plus a cylinder face as an axis distance, not the diameter', () => {
    // The old routing saw one body id, measured the cylinder alone and returned
    // its diameter, dropping the plane. The axis lies in the z=0 plane, so the
    // pair reads the axis-to-plane distance.
    expect(measureSelection(new Set(['@builtin_plane_top', '?hole']), ctx))
      .toEqual(['axis distance 15.000 mm'])
  })

  it('measures a sketch line plus a body edge in world space', () => {
    // The Top sketch's local y is world -z, but this line runs along local x, so
    // it lies at world y=0,z=0; the body edge is parallel at y=5.
    expect(measureSelection(new Set(['entity:skTop:L1', '?e1']), ctx))
      .toEqual(['distance 5.000 mm'])
  })

  it('measures a body vertex plus a datum plane', () => {
    expect(measureSelection(new Set(['?v0', '@builtin_plane_top']), ctx))
      .toEqual(['distance 0.000 mm'])
  })
})

describe('measureSelection: the pick count decides (D3)', () => {
  it('reads nothing for an empty selection', () => {
    expect(measureSelection(new Set(), ctx)).toEqual([])
  })

  it('reads a single body edge', () => {
    expect(measureSelection(new Set(['?e1']), ctx)).toEqual(['length 10.000 mm'])
  })

  it('reads nothing for a single datum plane or a single vertex', () => {
    expect(measureSelection(new Set(['@builtin_plane_top']), ctx)).toEqual([])
    expect(measureSelection(new Set(['?v0']), ctx)).toEqual([])
  })

  it('reads nothing for three picks', () => {
    expect(measureSelection(new Set(['entity:skTop:L1', '?e1', '@builtin_plane_top']), ctx))
      .toEqual([])
  })

  it('reads nothing for two picks plus a whole-body pick', () => {
    expect(measureSelection(new Set(['entity:skTop:L1', '?e1', '@body_1']), ctx))
      .toEqual([])
  })

  it('reads nothing for two whole-body picks', () => {
    expect(measureSelection(new Set(['@body_1', '@body_2']), ctx)).toEqual([])
  })
})

describe('measureSelection: an unresolvable pick does not shrink the selection', () => {
  it('reads nothing when one pick is junk, even though the other is measurable', () => {
    expect(measureSelection(new Set(['garbage', '?e1']), ctx)).toEqual([])
  })

  it('reads nothing when one pick is a constraint', () => {
    expect(measureSelection(new Set(['constraint:sk1:c1', '?e1']), ctx)).toEqual([])
  })

  it('reads nothing when an entity belongs to no solved sketch and no flat sketch', () => {
    expect(measureSelection(new Set(['entity:ghost:L1', '?e1']), ctx)).toEqual([])
  })

  it('reads nothing when the bodies are not available', () => {
    expect(measureSelection(new Set(['?e1']), { solveResults })).toEqual([])
  })
})

describe('measureSelection: kernel cells read nothing until the follow-up', () => {
  it('reads nothing for a whole-body pick alone', () => {
    expect(measureSelection(new Set(['@body_1']), ctx)).toEqual([])
  })

  it('reads nothing for a pair that needs the kernel', () => {
    expect(measureSelection(new Set(['@body_1', '?e1']), ctx)).toEqual([])
  })
})

describe('measureSelection: the document unit and its extras', () => {
  it('labels the number in the document unit without converting it', () => {
    expect(measureSelection(new Set(['?e1']), { ...ctx, unit: 'inch' }))
      .toEqual(['length 10.000 in'])
  })

  it('returns the second readout of a pair on its own HUD line', () => {
    const skew: BodyResult = {
      ...body,
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
        { kind: 'line', start: [5, 3, 4], end: [5, 7, 4] },
      ],
      edge_queries: ['?a', '?b'],
    }
    expect(measureSelection(new Set(['?a', '?b']), { bodies: { body_1: skew } }))
      .toEqual(['angle 90.0°', 'distance 5.000 mm'])
  })
})

describe('measureSelection: the flat sketch is a fallback only', () => {
  it('uses the flat sketch when no solve result names the feature', () => {
    expect(measureSelection(new Set(['entity:S1:L1']), { sketch: flat }))
      .toEqual(['length 10.000 mm'])
  })

  it('lifts a flat sketch with the FRONT identity frame when no frame is supplied', () => {
    // An unresolved frame keeps the old local-as-world reading rather than a
    // wrong lift; the fallback exists for fixtures and sketch-edit callers.
    expect(measureSelection(new Set(['entity:S1:L1']), { sketch: flat }))
      .toEqual(['length 10.000 mm'])
  })
})
