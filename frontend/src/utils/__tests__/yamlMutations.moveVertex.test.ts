import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyMoveVertex, applyAddConstraint } from '@/utils/yamlMutations'

const makeSampleDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [
    {
      id: 'Sketch1',
      kind: 'sketch',
      initial: {
        line1: [0, 0, 10, 0],
        circ1: [5, 5, 3],
        pt1: [1, 2],
      },
      entities: [
        { id: 'line1', kind: 'line' },
        { id: 'circ1', kind: 'circle' },
        { id: 'pt1', kind: 'point' },
      ],
      constraints: [
        { id: 'c_horiz', kind: 'horizontal', target: '$line1' },
        { id: 'c_len', kind: 'length', target: '$line1', value: 10 },
      ],
    },
  ],
})

describe('applyMoveVertex', () => {
  it('moves line start', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'start', [2, 3])
    expect(doc.features![0].initial!.line1).toEqual([2, 3, 10, 0])
  })

  it('moves line end', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'end', [15, 5])
    expect(doc.features![0].initial!.line1).toEqual([0, 0, 15, 5])
  })

  it('moves circle center', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'circ1', 'center', [7, 8])
    expect(doc.features![0].initial!.circ1).toEqual([7, 8, 3])
  })

  it('moves point xy', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'pt1', 'xy', [9.5, 10.5])
    expect(doc.features![0].initial!.pt1).toEqual([9.5, 10.5])
  })

  // A NaN drop position (broken pointer math upstream) must not be rounded into
  // the document: round(NaN) is still NaN and poisons the sketch seed.
  it('ignores a non-finite drop position instead of persisting NaN', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'start', [NaN, 3])
    expect(doc.features![0].initial!.line1).toEqual([0, 0, 10, 0])
  })

  // arc1 = [cx, cy, r, angle_start, angle_end]; start/end are derived points,
  // not direct param pairs, so the drop position maps into radius + angle.
  const makeArcDoc = (params: number[] = [0, 0, 5, 0, 90]): PartDoc => ({
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'Sketch1', kind: 'sketch',
        initial: { arc1: params },
        entities: [{ id: 'arc1', kind: 'arc' }],
        constraints: [],
      },
    ],
  })

  it('moves arc start by mapping the drop point into radius/angle', () => {
    const doc = makeArcDoc()
    // start at (5,0). Drop at (6,0): radius grows to 6, start angle stays 0,
    // end (angle 90) is unchanged.
    applyMoveVertex(doc, 'Sketch1', 'arc1', 'start', [6, 0])
    expect(doc.features![0].initial!.arc1).toEqual([0, 0, 6, 0, 90])
  })

  it('moves arc end by mapping the drop point into radius/angle', () => {
    const doc = makeArcDoc()
    // Drop the end at (0,3): radius shrinks to 3, end angle stays 90.
    applyMoveVertex(doc, 'Sketch1', 'arc1', 'end', [0, 3])
    expect(doc.features![0].initial!.arc1).toEqual([0, 0, 3, 0, 90])
  })

  it('keeps the arc angle on its continuous branch across the +/-180 seam', () => {
    const doc = makeArcDoc([0, 0, 5, 170, 270])
    // Drop start just past 180deg (at angle ~190 => atan2 returns ~-170);
    // the result must stay near 190, not jump to -170.
    const rad = (190 * Math.PI) / 180
    applyMoveVertex(doc, 'Sketch1', 'arc1', 'start', [5 * Math.cos(rad), 5 * Math.sin(rad)])
    expect(doc.features![0].initial!.arc1[3]).toBeCloseTo(190, 4)
  })

  // ell1 = [cx, cy, a, b, theta]; the 4 axis handles are derived points like the
  // arc endpoints above, so a drag maps the drop position back into a/b/theta.
  // They used to silently no-op: VERTEX_INDICES['ellipse'] only maps 'center'.
  const makeEllipseDoc = (params: number[] = [0, 0, 10, 5, 0]): PartDoc => ({
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'Sketch1', kind: 'sketch',
        initial: { ell1: params },
        entities: [{ id: 'ell1', kind: 'ellipse' }],
        constraints: [],
      },
    ],
  })

  it('moves ellipse center', () => {
    const doc = makeEllipseDoc()
    applyMoveVertex(doc, 'Sketch1', 'ell1', 'center', [3, 4])
    expect(doc.features![0].initial!.ell1).toEqual([3, 4, 10, 5, 0])
  })

  it('moves an ellipse major handle by mapping the drop point into a/theta', () => {
    const doc = makeEllipseDoc()
    // major1 sits at (10,0). Drop it straight above the center: a = 12, theta = 90.
    applyMoveVertex(doc, 'Sketch1', 'ell1', 'major1', [0, 12])
    expect(doc.features![0].initial!.ell1).toEqual([0, 0, 12, 5, 90])
  })

  it('moves an ellipse minor handle by resizing b only', () => {
    const doc = makeEllipseDoc()
    // The off-axis x component is projected away: no rotation, a unchanged.
    applyMoveVertex(doc, 'Sketch1', 'ell1', 'minor1', [7, 9])
    expect(doc.features![0].initial!.ell1).toEqual([0, 0, 10, 9, 0])
  })

  it('no-ops an ellipse major handle dropped on the center', () => {
    const doc = makeEllipseDoc()
    applyMoveVertex(doc, 'Sketch1', 'ell1', 'major1', [0, 0])
    expect(doc.features![0].initial!.ell1).toEqual([0, 0, 10, 5, 0])
  })

  // The construction flag is presentation only: it must never gate a drag.
  it('moves a construction line endpoint like an ordinary one', () => {
    const doc = makeSampleDoc()
    doc.features![0].entities![0].construction = true
    applyMoveVertex(doc, 'Sketch1', 'line1', 'end', [15, 5])
    expect(doc.features![0].initial!.line1).toEqual([0, 0, 15, 5])
  })

  it('no-ops for unknown entity', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'nonexistent', 'start', [0, 0])
    expect(doc.features![0].initial!.line1).toEqual([0, 0, 10, 0])
  })

  it('rounds coordinates to 6 decimal places', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'start', [1.23456789, 9.87654321])
    expect(doc.features![0].initial!.line1[0]).toBe(1.234568)
    expect(doc.features![0].initial!.line1[1]).toBe(9.876543)
  })

  // ─── solvedGeometry: the drag commit writes the whole solved frame ───

  it('writes solvedGeometry into initial for all entities, vertex on top', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'end', [15.5, 5], {
      line1: [0.5, 0.5, 15.2, 4.8],  // last drag frame; end overridden by `to`
      circ1: [6, 6, 3],
      pt1: [2, 3],
    })
    expect(doc.features![0].initial!.line1).toEqual([0.5, 0.5, 15.5, 5])
    expect(doc.features![0].initial!.circ1).toEqual([6, 6, 3])
    expect(doc.features![0].initial!.pt1).toEqual([2, 3])
  })

  it('rounds solvedGeometry params like direct vertex writes', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'end', [15, 5], {
      circ1: [6.123456789, 6, 3],
    })
    expect(doc.features![0].initial!.circ1[0]).toBe(6.123457)
  })

  it('skips unknown or param-count-mismatched solvedGeometry entries', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'end', [15, 5], {
      ghost: [1, 2],  // not in initial: must not be created
      circ1: [6, 6],  // wrong param count for a circle: must not corrupt
    })
    expect(doc.features![0].initial!.ghost).toBeUndefined()
    expect(doc.features![0].initial!.circ1).toEqual([5, 5, 3])
  })
})

describe('move_vertex_with_constraint (combined applyMoveVertex + applyAddConstraint)', () => {
  it('moves vertex and adds constraint atomically', () => {
    const doc = makeSampleDoc()
    applyMoveVertex(doc, 'Sketch1', 'line1', 'end', [20, 5])
    applyAddConstraint(doc, 'Sketch1', 'coincident', [
      'vertex:Sketch1:line1:end',
      'vertex:Sketch1:circ1:center',
    ])
    expect(doc.features![0].initial!.line1).toEqual([0, 0, 20, 5])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.kind === 'coincident')
    expect(added).toBeDefined()
    expect(added!.a).toEqual('$line1end')
    expect(added!.b).toEqual('$circ1center')
  })

  it('vertex moves before constraint is added (order matters)', () => {
    const doc = makeSampleDoc()
    const countBefore = doc.features![0].constraints!.length
    applyMoveVertex(doc, 'Sketch1', 'line1', 'start', [3, 4])
    applyAddConstraint(doc, 'Sketch1', 'coincident', [
      'vertex:Sketch1:line1:start',
      'vertex:Sketch1:pt1:xy',
    ])
    expect(doc.features![0].initial!.line1).toEqual([3, 4, 10, 0])
    expect(doc.features![0].constraints!.length).toBe(countBefore + 1)
  })
})
