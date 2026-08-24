import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PartDoc, PartConstraint } from '@/types/cad'
import { applyMoveVertex, applyAddConstraint, applyDeleteElements, applySetConstraintPos, applyAddPlane, applySetPlaneDefinitionField, applyAddEntityWithConstraint, applyAddImportStep, applyDeleteFeature, dropDeadAxisConstraints } from '@/utils/yamlMutations'
import {
  applyRemoveExtrudeProfile, applyRemoveFilletEdge, applyRemoveDeleteBodyRef, applyRemoveTransformBody,
} from '@/utils/yamlMutations'

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

describe('applyAddConstraint', () => {
  it('adds a single-target constraint', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.id.startsWith('c_vertical'))
    expect(added).toBeDefined()
    expect(added!.kind).toBe('vertical')
    expect(added!.target).toEqual('$line1')
  })

  it('adds a two-target constraint', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'normal', ['entity:Sketch1:line1', 'entity:Sketch1:circ1'])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.id.startsWith('c_normal'))
    expect(added).toBeDefined()
    expect(added!.a).toEqual('$line1')
    expect(added!.b).toEqual('$circ1')
  })

  it('adds constraint with vertex point reference', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['vertex:Sketch1:line1:end', 'vertex:Sketch1:circ1:center'])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.id.startsWith('c_coincident'))
    expect(added).toBeDefined()
    expect(added!.a).toEqual('$line1end')
    expect(added!.b).toEqual('$circ1center')
  })

  it('generates unique constraint ids', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:circ1'])
    const ids = doc.features![0].constraints!.map((c: PartConstraint) => c.id)
    const vertIds = ids.filter((id: string) => id.startsWith('c_vertical'))
    expect(new Set(vertIds).size).toBe(vertIds.length)
  })

  it('adds constraint with value', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'length', ['entity:Sketch1:line1'], 42)
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.id.startsWith('c_length'))
    expect(added!.value).toBe(42)
  })

  it('adds coincident constraint with @builtin_origin target', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'coincident', [
      'vertex:Sketch1:line1:start',
      '@builtin_origin',
    ])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.kind === 'coincident')
    expect(added).toBeDefined()
    expect(added!.a).toBe('$line1start')
    expect(added!.b).toBe('@builtin_origin')
  })

  it('horizontal with two vertices sets a and b refs', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'horizontal', ['vertex:Sketch1:line1:start', 'vertex:Sketch1:line1:end'])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.kind === 'horizontal' && c.a !== undefined)
    expect(added).toBeDefined()
    expect(added!.a).toBe('$line1start')
    expect(added!.b).toBe('$line1end')
    expect(added!.target).toBeUndefined()
  })

  it('vertical with two vertices sets a and b refs', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['vertex:Sketch1:line1:start', 'vertex:Sketch1:line1:end'])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.kind === 'vertical' && c.a !== undefined)
    expect(added).toBeDefined()
    expect(added!.a).toBe('$line1start')
    expect(added!.b).toBe('$line1end')
    expect(added!.target).toBeUndefined()
  })

  it('horizontal with single line target uses target ref', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'horizontal', ['entity:Sketch1:line1'])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.kind === 'horizontal' && c.target !== undefined)
    expect(added).toBeDefined()
    expect(added!.target).toBe('$line1')
    expect(added!.a).toBeUndefined()
  })

  // Regression: bugreports/vertical_constraint_20260621_102915.md. A vertical
  // applied with a circle picked up alongside the line authored `a: circle,
  // b: line`, whose a/b residual (circle.center.x == line.start.x) was already
  // satisfied, so the line never turned vertical. Two whole entities are not two
  // points: the constraint must be rejected, not authored as a dead a/b.
  it('vertical with two whole entities is rejected (not authored as a/b)', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:circ1', 'entity:Sketch1:line1'])
    const constraints = doc.features![0].constraints!
    expect(constraints.find(c => c.kind === 'vertical')).toBeUndefined()
  })

  it('horizontal with an entity in the a/b slot is rejected', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'horizontal', ['vertex:Sketch1:line1:start', 'entity:Sketch1:circ1'])
    const constraints = doc.features![0].constraints!
    expect(constraints.find(c => c.kind === 'horizontal' && c.a !== undefined)).toBeUndefined()
  })
})

describe('applyAddConstraint midpoint', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('entity+vertex combo sets line and point', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'midpoint', [
      'entity:Sketch1:line1',
      'vertex:Sketch1:pt1:xy',
    ])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.kind === 'midpoint')
    expect(added).toBeDefined()
    expect(added!.line).toBe('$line1')
    expect(added!.point).toBe('$pt1xy')
    expect(added!.a).toBeUndefined()
  })

  it('three-vertex combo sets point_a, point_b, point', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'midpoint', [
      'vertex:Sketch1:line1:start',
      'vertex:Sketch1:line1:end',
      'vertex:Sketch1:pt1:xy',
    ])
    const constraints = doc.features![0].constraints!
    const added = constraints.find(c => c.kind === 'midpoint')
    expect(added).toBeDefined()
    expect(added!.point_a).toBe('$line1start')
    expect(added!.point_b).toBe('$line1end')
    expect(added!.point).toBe('$pt1xy')
  })

  it('unrecognized target combo does not add constraint and calls console.warn in dev mode', () => {
    const doc = makeSampleDoc()
    const countBefore = doc.features![0].constraints!.length
    // Two entity targets, not a recognized midpoint pattern
    applyAddConstraint(doc, 'Sketch1', 'midpoint', [
      'entity:Sketch1:line1',
      'entity:Sketch1:circ1',
    ])
    expect(doc.features![0].constraints!.length).toBe(countBefore)
    // warn is called in dev mode (vitest runs with DEV=true via import.meta.env.DEV)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('midpoint'),
      expect.anything(),
    )
  })
})

// A generic kind used to fall through every branch when its target list was
// empty (or a single pick for coincident), authoring an operand-less constraint.
describe('applyAddConstraint operand guards', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('a generic kind with no targets adds nothing and warns', () => {
    const doc = makeSampleDoc()
    const countBefore = doc.features![0].constraints!.length
    applyAddConstraint(doc, 'Sketch1', 'parallel', [])
    expect(doc.features![0].constraints!.length).toBe(countBefore)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('parallel'),
      expect.anything(),
    )
  })

  it('coincident with a single target is rejected rather than authored half-picked', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['entity:Sketch1:circ1'])
    expect(doc.features![0].constraints!.find(c => c.kind === 'coincident')).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('coincident'),
      expect.anything(),
    )
  })

  it('a valid two-target coincident still adds', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['vertex:Sketch1:line1:end', 'vertex:Sketch1:circ1:center'])
    const added = doc.features![0].constraints!.find(c => c.kind === 'coincident')
    expect(added).toBeDefined()
    expect(added!.a).toEqual('$line1end')
    expect(added!.b).toEqual('$circ1center')
  })

  it('a single-target generic kind keeps its target form', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'length', ['entity:Sketch1:line1'], 42)
    const added = doc.features![0].constraints!.find(c => c.kind === 'length')
    expect(added).toBeDefined()
    expect(added!.target).toBe('$line1')
    expect(warnSpy).not.toHaveBeenCalled()
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

describe('applySetConstraintPos', () => {
  it('sets pos on an existing constraint', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_len', [3.5, -2.0])
    const c = doc.features![0].constraints!.find(c => c.id === 'c_len')
    expect(c!.pos).toEqual([3.5, -2.0])
  })

  it('rounds pos to 6 decimal places', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_len', [1.23456789, -9.87654321])
    const c = doc.features![0].constraints!.find(c => c.id === 'c_len')
    expect(c!.pos![0]).toBe(1.234568)
    expect(c!.pos![1]).toBe(-9.876543)
  })

  it('no-ops for unknown constraint', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_nonexistent', [1, 2])
    // No pos set on any constraint
    for (const c of doc.features![0].constraints!) {
      expect(c.pos).toBeUndefined()
    }
  })

  it('no-ops for unknown feature', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'NoSuchFeature', 'c_len', [1, 2])
    const c = doc.features![0].constraints!.find(c => c.id === 'c_len')
    expect(c!.pos).toBeUndefined()
  })
})

describe('applyDeleteElements', () => {
  it('deletes an entity from entities list and initial', () => {
    const doc = makeSampleDoc()
    applyDeleteElements(doc, ['entity:Sketch1:circ1'])
    expect(doc.features![0].entities).toHaveLength(2)
    expect(doc.features![0].entities!.map(e => e.id)).not.toContain('circ1')
    expect(doc.features![0].initial!.circ1).toBeUndefined()
    expect(doc.features![0].initial!.line1).toBeDefined()
  })

  it('deletes a constraint', () => {
    const doc = makeSampleDoc()
    applyDeleteElements(doc, ['constraint:Sketch1:c_horiz'])
    expect(doc.features![0].constraints).toHaveLength(1)
    expect(doc.features![0].constraints![0].id).toBe('c_len')
  })

  it('deletes multiple elements at once', () => {
    const doc = makeSampleDoc()
    applyDeleteElements(doc, ['entity:Sketch1:line1', 'constraint:Sketch1:c_len'])
    expect(doc.features![0].entities).toHaveLength(2)
    // Both constraints reference $line1; c_len is explicitly deleted and
    // c_horiz is garbage-collected because it references the deleted entity.
    expect(doc.features![0].constraints).toHaveLength(0)
    expect(doc.features![0].initial!.line1).toBeUndefined()
  })

  it('deletes constraints that reference deleted entities', () => {
    const doc = makeSampleDoc()
    applyDeleteElements(doc, ['entity:Sketch1:line1'])
    expect(doc.features![0].entities).toHaveLength(2)
    // Both constraints reference $line1 and should be garbage-collected
    expect(doc.features![0].constraints).toHaveLength(0)
  })

  it('deletes constraints referencing deleted entity sub-points', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'Sketch1',
        kind: 'sketch',
        initial: { line1: [0, 0, 10, 0] },
        entities: [{ id: 'line1', kind: 'line' }],
        constraints: [
          { id: 'c_coin', kind: 'coincident', a: '$line1start', b: '$line1end' },
        ],
      }],
    }
    applyDeleteElements(doc, ['entity:Sketch1:line1'])
    expect(doc.features![0].constraints).toHaveLength(0)
  })

  it('keeps constraints that do not reference deleted entities', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'Sketch1',
        kind: 'sketch',
        initial: { line1: [0, 0, 10, 0], line2: [0, 0, 0, 10] },
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'line2', kind: 'line' },
        ],
        constraints: [
          { id: 'c_horiz', kind: 'horizontal', target: '$line1' },
          { id: 'c_vert', kind: 'vertical', target: '$line2' },
        ],
      }],
    }
    applyDeleteElements(doc, ['entity:Sketch1:line1'])
    expect(doc.features![0].constraints).toHaveLength(1)
    expect(doc.features![0].constraints![0].id).toBe('c_vert')
  })
})

// ─── Step 6: face: selection ID handling ───

import { parseTarget, applySetFeatureVisibility, applyReorderFeatures } from '@/utils/yamlMutations'


const docWithSketch = (id: string): PartDoc => ({
  version: 1, kind: 'part',
  features: [{ id, kind: 'sketch', entities: [{ id: 'lineA', kind: 'line' }], initial: { lineA: [0,0,10,0] }, constraints: [] }],
})

// 6c: parseTarget for @featureId feature-plane references
// A bare @<featureId> (no element suffix) is a feature-plane reference.
// parseTarget must pass it through unchanged so the solver can resolve
// it to the feature's defining plane.
describe('parseTarget for feature-plane references', () => {
  it('passes through @featureId unchanged (sketch feature-plane ref)', () => {
    expect(parseTarget('@sketch1', 'sketch2')).toBe('@sketch1')
  })

  it('passes through @featureId unchanged even from same feature context', () => {
    expect(parseTarget('@sketch1', 'sketch1')).toBe('@sketch1')
  })

  it('passes through builtin plane references unchanged', () => {
    expect(parseTarget('@builtin_plane_front', 'sketch1')).toBe('@builtin_plane_front')
    expect(parseTarget('@builtin_plane_top', 'sketch1')).toBe('@builtin_plane_top')
    expect(parseTarget('@builtin_plane_right', 'sketch1')).toBe('@builtin_plane_right')
  })

  it('passes through @extrude feature-plane ref unchanged', () => {
    // @extrude1 will resolve to extrude1's origin/top plane (resolved by the kernel).
    // The frontend must pass it through without modification.
    expect(parseTarget('@extrude1', 'sketch2')).toBe('@extrude1')
  })
})

// 6a: parseTarget for face: IDs
describe('parseTarget for face IDs', () => {
  it('returns raw query for face from different feature', () => {
    expect(parseTarget('face:sketch0:?3;@sketch0abc', 'sketch1')).toBe('?3;@sketch0abc')
  })

  it('returns raw query for face from same feature', () => {
    expect(parseTarget('face:sketch1:?3;@sketch1abc', 'sketch1')).toBe('?3;@sketch1abc')
  })

  it('preserves colon in type restriction suffix', () => {
    expect(parseTarget('face:sketch0:?9,9;@sketch0la@sketch0lb:face', 'sketch1')).toBe('?9,9;@sketch0la@sketch0lb:face')
  })
})

// 6b: applyAddConstraint stores face query verbatim
describe('applyAddConstraint with face target', () => {
  it('stores face ancestry query verbatim as constraint field', () => {
    const doc = docWithSketch('sketch1')
    applyAddConstraint(doc, 'sketch1', 'coincident',
      ['vertex:sketch1:lineA:start', 'face:sketch0:?3;@sketch0abc'])
    const c = doc.features![0].constraints![0]
    expect(c.b).toBe('?3;@sketch0abc')
  })

  it('stores face query with type restriction verbatim', () => {
    const doc = docWithSketch('sketch1')
    applyAddConstraint(doc, 'sketch1', 'coincident',
      ['vertex:sketch1:lineA:start', 'face:sketch0:?9,9;@sketch0la@sketch0lb:face'])
    const c = doc.features![0].constraints![0]
    expect(c.b).toBe('?9,9;@sketch0la@sketch0lb:face')
  })
})

// ─── Feature visibility (applySetFeatureVisibility) ───

const docWithFeatures = (): PartDoc => ({
  version: 1, kind: 'part',
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'Front',  kind: 'plane' },
    { id: 'sketch1', kind: 'sketch' },
  ],
})

describe('applySetFeatureVisibility', () => {
  it('sets visible:false when hiding', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'sketch1', false)
    expect(doc.features!.find(f => f.id === 'sketch1')!.visible).toBe(false)
  })

  it('removes the visible property when showing (keeps YAML clean)', () => {
    const doc = docWithFeatures()
    doc.features!.find(f => f.id === 'sketch1')!.visible = false
    applySetFeatureVisibility(doc, 'sketch1', true)
    expect('visible' in doc.features!.find(f => f.id === 'sketch1')!).toBe(false)
  })

  it('works on built-in features (origin)', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'Origin', false)
    expect(doc.features!.find(f => f.id === 'Origin')!.visible).toBe(false)
  })

  it('works on built-in features (plane)', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'Front', false)
    expect(doc.features!.find(f => f.id === 'Front')!.visible).toBe(false)
  })

  it('no-ops for unknown feature id', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'nonexistent', false)
    expect(doc.features!.every(f => f.visible === undefined)).toBe(true)
  })

  it('does not affect other features when hiding one', () => {
    const doc = docWithFeatures()
    applySetFeatureVisibility(doc, 'sketch1', false)
    expect(doc.features!.find(f => f.id === 'Origin')!.visible).toBeUndefined()
    expect(doc.features!.find(f => f.id === 'Front')!.visible).toBeUndefined()
  })
})

describe('applyAddPlane', () => {
  it('adds a plane feature with default offset mode', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyAddPlane(doc, 'plane1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toEqual({ id: 'plane1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front' } })
  })

  it('creates features array if missing', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applyAddPlane(doc, 'plane1')
    expect(doc.features).toHaveLength(1)
  })

  it('appends to existing features', () => {
    const doc = makeSampleDoc()
    applyAddPlane(doc, 'plane1')
    expect(doc.features).toHaveLength(2)
    expect(doc.features![1].id).toBe('plane1')
  })
})

describe('applySetPlaneDefinitionField', () => {
  it('sets plane field on a plane feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'plane1', kind: 'plane', definition: { mode: 'offset' } }] }
    applySetPlaneDefinitionField(doc, 'plane1', 'plane', '@builtin_plane_top')
    expect(doc.features![0].definition!.plane).toBe('@builtin_plane_top')
  })

  it('sets offset field', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'plane1', kind: 'plane', definition: { mode: 'offset' } }] }
    applySetPlaneDefinitionField(doc, 'plane1', 'offset', 25)
    expect(doc.features![0].definition!.offset).toBe(25)
  })

  it('creates definition if missing', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{ id: 'plane1', kind: 'plane' }] }
    applySetPlaneDefinitionField(doc, 'plane1', 'mode', 'three_point')
    expect(doc.features![0].definition).toBeDefined()
    expect((doc.features![0].definition as Record<string, unknown>).mode).toBe('three_point')
  })

  it('is no-op for unknown featureId', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    expect(() => applySetPlaneDefinitionField(doc, 'nonexistent', 'plane', '@builtin_plane_top')).not.toThrow()
  })
})

describe('applyAddEntityWithConstraint', () => {
  it('adds entity and creates coincident constraint with existing vertex', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }],
      initial: { line1: [0, 0, 10, 0] },
      constraints: [{ id: 'c1', kind: 'horizontal', target: '$line1' }],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [5, 5, 15, 5], 'start', 'vertex:Sketch1:line1:end', 'coincident')
    expect(doc.features![0].entities).toHaveLength(2)
    expect(doc.features![0].entities![1].kind).toBe('line')
    expect(doc.features![0].initial![doc.features![0].entities![1].id]).toEqual([5, 5, 15, 5])
    expect(doc.features![0].constraints).toHaveLength(2)
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')
    expect(newConstraint).toBeDefined()
  })

  it('rounds coordinates to 6 decimal places', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }],
      initial: { line1: [0, 0, 10, 0] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'point', [1.23456789, 9.87654321], 'xy', 'vertex:Sketch1:line1:end', 'coincident')
    const newEntity = doc.features![0].entities![1]
    expect(doc.features![0].initial![newEntity.id]![0]).toBe(1.234568)
    expect(doc.features![0].initial![newEntity.id]![1]).toBe(9.876543)
  })

  it('is no-op for unknown feature', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Nonexistent', 'line', [0, 0, 10, 10], 'start', 'vertex:Sketch1:line1:end', 'coincident')
    expect(doc.features![0].entities).toHaveLength(0)
  })

  it('creates concentric constraint for circle center snapping', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'circ1', kind: 'circle' }],
      initial: { circ1: [0, 0, 5] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'circle', [0, 0, 3], 'center', 'vertex:Sketch1:circ1:center', 'concentric')
    expect(doc.features![0].entities).toHaveLength(2)
    expect(doc.features![0].constraints).toHaveLength(1)
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'concentric')
    expect(newConstraint).toBeDefined()
    expect(newConstraint!.a).toBeDefined()
    expect(newConstraint!.b).toBeDefined()
  })

  it('constraint references new entity vertex and existing vertex', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }],
      initial: { line1: [0, 0, 10, 0] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 5, 5], 'start', 'vertex:Sketch1:line1:start', 'coincident')
    const newEntity = doc.features![0].entities![1]
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')!
    expect(newConstraint.a).toBe(`$${newEntity.id}start`)
    expect(newConstraint.b).toBe('$line1start')
  })

  it('handles arc end vertex snapping', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'arc1', kind: 'arc' }],
      initial: { arc1: [5, 5, 3, 0, 90] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'arc', [5, 5, 3, 0, 90], 'end', 'vertex:Sketch1:arc1:end', 'coincident')
    expect(doc.features![0].entities).toHaveLength(2)
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')
    expect(newConstraint).toBeDefined()
  })

  it('generates unique entity ids', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      initial: {},
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 10, 10], 'start', 'vertex:Sketch1:line1:end', 'coincident')
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 5, 5], 'start', 'vertex:Sketch1:line1:end', 'coincident')
    const entities = doc.features![0].entities
    expect(entities).toHaveLength(2)
    expect(entities![0].id).not.toBe(entities![1].id)
  })

  it('creates constraint with entity reference when using snapEntityRef', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }],
      initial: { line1: [0, 0, 10, 0] },
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 5, 5, 5], 'end', undefined, 'coincident', 'entity:Sketch1:line1')
    const newEntity = doc.features![0].entities![1]
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')!
    expect(newConstraint.a).toBe(`$${newEntity.id}end`)
    expect(newConstraint.b).toBe('$line1')
  })

  it('is no-op when neither snapVertexId nor snapEntityRef provided', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      initial: {},
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 10, 10], 'start', undefined, 'coincident', undefined)
    expect(doc.features![0].entities).toHaveLength(1)
    expect(doc.features![0].constraints).toHaveLength(0)
  })

  it('uses source feature ID for cross-sketch snap vertex', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      initial: {},
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 5, 5], 'start', 'vertex:Sketch2:line1:start', 'coincident')
    const newEntity = doc.features![0].entities![0]
    const newConstraint = doc.features![0].constraints!.find(c => c.kind === 'coincident')!
    expect(newConstraint.a).toBe(`$${newEntity.id}start`)
    // Absolute cross-feature refs are slash-joined (canonical kernel format).
    expect(newConstraint.b).toBe('@Sketch2/line1/start')
  })
})

describe('applyAddImportStep', () => {
  it('adds an import_step feature with file_id', () => {
    const doc: PartDoc = { features: [] }
    applyAddImportStep(doc, 'f1', 'abc123.step')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toMatchObject({ id: 'f1', kind: 'import_step', file_id: 'abc123.step' })
  })

  it('sets label when provided', () => {
    const doc: PartDoc = { features: [] }
    applyAddImportStep(doc, 'f1', 'abc123.step', 'My Part')
    expect(doc.features![0].label).toBe('My Part')
  })

  it('stores inline file_data (browser-read, no upload handle)', () => {
    const doc: PartDoc = { features: [] }
    applyAddImportStep(doc, 'f1', undefined, 'My Part', 'SVNPLTEwMzAz')
    expect(doc.features![0]).toMatchObject({
      id: 'f1', kind: 'import_step', file_data: 'SVNPLTEwMzAz', label: 'My Part',
    })
    expect(doc.features![0].file_id).toBeUndefined()
  })

  it('initialises features array when absent', () => {
    const doc: PartDoc = {}
    applyAddImportStep(doc, 'f1', 'abc123.step')
    expect(doc.features).toHaveLength(1)
  })
})

describe('applyDeleteFeature', () => {
  it('deletes a user feature', () => {
    const doc = docWithFeatures()
    applyDeleteFeature(doc, 'sketch1')
    expect(doc.features!.map(f => f.id)).not.toContain('sketch1')
  })

  it('does not delete a built-in origin', () => {
    const doc = docWithFeatures()
    applyDeleteFeature(doc, 'Origin')
    expect(doc.features!.map(f => f.id)).toContain('Origin')
  })

  it('does not delete a built-in plane', () => {
    const doc = docWithFeatures()
    applyDeleteFeature(doc, 'Front')
    expect(doc.features!.map(f => f.id)).toContain('Front')
  })

  it('does not delete Top built-in', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top',    kind: 'plane' },
      { id: 'Front',  kind: 'plane' },
      { id: 'Right',  kind: 'plane' },
      { id: 'mySketch', kind: 'sketch' },
    ] }
    applyDeleteFeature(doc, 'Top')
    expect(doc.features!.map(f => f.id)).toContain('Top')
  })

  it('does not delete Right built-in', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top',    kind: 'plane' },
      { id: 'Front',  kind: 'plane' },
      { id: 'Right',  kind: 'plane' },
      { id: 'mySketch', kind: 'sketch' },
    ] }
    applyDeleteFeature(doc, 'Right')
    expect(doc.features!.map(f => f.id)).toContain('Right')
  })
})

describe('applyAddEntityWithConstraint with @builtin_origin', () => {
  it('creates coincident constraint with @builtin_origin snap target', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [{
      id: 'Sketch1', kind: 'sketch',
      entities: [],
      initial: {},
      constraints: [],
    }] }
    applyAddEntityWithConstraint(doc, 'Sketch1', 'point', [3, 4], 'xy', '@builtin_origin', 'coincident')
    expect(doc.features![0].entities).toHaveLength(1)
    expect(doc.features![0].constraints).toHaveLength(1)
    const c = doc.features![0].constraints![0]
    expect(c.kind).toBe('coincident')
    expect(c.b).toBe('@builtin_origin')
  })
})

// ─── Feature reordering ───

const docWithBuiltInsAndUser = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'Top', kind: 'plane' },
    { id: 'Front', kind: 'plane' },
    { id: 'Right', kind: 'plane' },
    { id: 'sketch1', kind: 'sketch' },
    { id: 'sketch2', kind: 'sketch' },
    { id: 'sketch3', kind: 'sketch' },
  ],
})

describe('applyReorderFeatures', () => {
  it('moves a feature to a later index', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'sketch1', 6)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch2', 'sketch1', 'sketch3'])
  })

  it('moves a feature to an earlier index', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'sketch3', 4)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch3', 'sketch1', 'sketch2'])
  })

  it('no-ops when dropping a feature on itself', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'sketch2', 5)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch1', 'sketch2', 'sketch3'])
  })

  it('protects built-in features from being moved', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'Origin', 6)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch1', 'sketch2', 'sketch3'])
  })

  it('clamps drop target before built-ins to after built-ins', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'sketch2', 2)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch2', 'sketch1', 'sketch3'])
  })

  it('no-ops for unknown feature id', () => {
    const doc = docWithBuiltInsAndUser()
    applyReorderFeatures(doc, 'nonexistent', 5)
    const ids = doc.features!.map(f => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'sketch1', 'sketch2', 'sketch3'])
  })

  it('works with empty features array', () => {
    const doc: PartDoc = { version: 1, kind: 'part', features: [] }
    applyReorderFeatures(doc, 'sketch1', 0)
    expect(doc.features).toHaveLength(0)
  })
})

describe('dropDeadAxisConstraints', () => {
  // Mirrors the stale doc in bugreports/weird_constraint_20260621_214037.md: a
  // vertical whose a/b operands are a whole circle and a whole line. Each resolves
  // to a single sub-point, so the constraint is degenerate and must be pruned.
  const docWithDeadVertical = (): PartDoc => ({
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'Sketch1',
        kind: 'sketch',
        initial: { line1: [0, 0, 10, 0], circ1: [5, 5, 3], pt1: [1, 2], pt2: [3, 4] },
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'circ1', kind: 'circle' },
          { id: 'pt1', kind: 'point' },
          { id: 'pt2', kind: 'point' },
        ],
        constraints: [
          { id: 'c_dead', kind: 'vertical', a: '$circ1', b: '$line1' },
        ],
      },
    ],
  })

  it('removes a vertical between two whole entities', () => {
    const doc = docWithDeadVertical()
    const removed = dropDeadAxisConstraints(doc)
    expect(removed).toBe(1)
    expect(doc.features![0].constraints).toHaveLength(0)
  })

  it('removes a horizontal whose single operand is a whole entity', () => {
    const doc = docWithDeadVertical()
    doc.features![0].constraints = [
      { id: 'c_dead', kind: 'horizontal', a: '$circ1', b: '$pt1' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(1)
    expect(doc.features![0].constraints).toHaveLength(0)
  })

  it('keeps a valid two-point vertical (point entity + line endpoint)', () => {
    const doc = docWithDeadVertical()
    doc.features![0].constraints = [
      { id: 'c_ok', kind: 'vertical', a: '$pt1', b: '$line1start' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(0)
    expect(doc.features![0].constraints).toHaveLength(1)
  })

  it('keeps a valid two-point vertical between two point entities', () => {
    const doc = docWithDeadVertical()
    doc.features![0].constraints = [
      { id: 'c_ok', kind: 'vertical', a: '$pt1', b: '$pt2' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(0)
    expect(doc.features![0].constraints).toHaveLength(1)
  })

  it('keeps the single-line target form (no a/b)', () => {
    const doc = docWithDeadVertical()
    doc.features![0].constraints = [
      { id: 'c_ok', kind: 'horizontal', target: '$line1' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(0)
    expect(doc.features![0].constraints).toHaveLength(1)
  })

  it('leaves non-axis constraints untouched', () => {
    const doc = docWithDeadVertical()
    doc.features![0].constraints = [
      { id: 'c_coin', kind: 'coincident', a: '$circ1', b: '$line1' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(0)
    expect(doc.features![0].constraints).toHaveLength(1)
  })
})

// One remover per shared splice site: the ref-list, edge-list and both body-list
// removers each had their own unchecked splice. splice(-1, 1) drops the LAST
// element, so an out-of-range index used to delete the wrong entry.
describe('remove-by-index mutators refuse out-of-range indices', () => {
  const cases: {
    name: string
    makeDoc: () => PartDoc
    remove: (doc: PartDoc, index: number) => void
    list: (doc: PartDoc) => string[] | undefined
  }[] = [
    {
      name: 'applyRemoveExtrudeProfile',
      makeDoc: () => ({
        version: 1,
        kind: 'part',
        features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: ['a', 'b'], distance: 10 } }],
      }),
      remove: (doc, index) => applyRemoveExtrudeProfile(doc, 'ex1', index),
      list: (doc) => {
        const sketch = doc.features![0].extrude!.sketch
        return Array.isArray(sketch) ? sketch : undefined
      },
    },
    {
      name: 'applyRemoveFilletEdge',
      makeDoc: () => ({
        version: 1,
        kind: 'part',
        features: [{ id: 'f1', kind: 'fillet', fillet: { edges: ['a', 'b'], radius: 2 } }],
      }),
      remove: (doc, index) => applyRemoveFilletEdge(doc, 'f1', index),
      list: (doc) => doc.features![0].fillet!.edges,
    },
    {
      name: 'applyRemoveDeleteBodyRef',
      makeDoc: () => ({
        version: 1,
        kind: 'part',
        features: [{ id: 'db1', kind: 'delete_body', delete_body: { bodies: ['a', 'b'] } }],
      }),
      remove: (doc, index) => applyRemoveDeleteBodyRef(doc, 'db1', index),
      list: (doc) => doc.features![0].delete_body!.bodies,
    },
    {
      name: 'applyRemoveTransformBody',
      makeDoc: () => ({
        version: 1,
        kind: 'part',
        features: [{
          id: 'xf1',
          kind: 'transform',
          transform: { bodies: ['a', 'b'], operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 },
        }],
      }),
      remove: (doc, index) => applyRemoveTransformBody(doc, 'xf1', index),
      list: (doc) => doc.features![0].transform!.bodies,
    },
  ]

  it.each(cases.map(c => c.name))('%s is a silent no-op for index -1 and index 5', (name) => {
    const c = cases.find(x => x.name === name)!
    for (const index of [-1, 5]) {
      const doc = c.makeDoc()
      expect(() => c.remove(doc, index)).not.toThrow()
      expect(c.list(doc)).toEqual(['a', 'b'])
    }
  })

  it.each(cases.map(c => c.name))('%s still removes at valid indices 0 and 1', (name) => {
    const c = cases.find(x => x.name === name)!
    const doc0 = c.makeDoc()
    c.remove(doc0, 0)
    expect(c.list(doc0)).toEqual(['b'])
    const doc1 = c.makeDoc()
    c.remove(doc1, 1)
    expect(c.list(doc1)).toEqual(['a'])
  })
})
