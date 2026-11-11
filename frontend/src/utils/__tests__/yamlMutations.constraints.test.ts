import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PartDoc, PartConstraint } from '@/types/cad'
import { applyAddConstraint, applySetConstraintValue, applySetConstraintPos, dropDeadAxisConstraints } from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'
import { sketchAt } from '@/testing/featureAccess'

const constraints0 = (doc: PartDoc) => featureAt(doc, 0, 'sketch').constraints!
const entities0 = (doc: PartDoc) => featureAt(doc, 0, 'sketch').entities!
const initial0 = (doc: PartDoc) => featureAt(doc, 0, 'sketch').initial!

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

describe('applyAddConstraint', () => {
  it('adds a single-target constraint', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    const constraints = constraints0(doc)
    const added = constraints.find(c => c.id.startsWith('c_vertical'))
    expect(added).toBeDefined()
    expect(added!.kind).toBe('vertical')
    expect(added!.target).toEqual('$line1')
  })

  it('adds a two-target constraint', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'normal', ['entity:Sketch1:line1', 'entity:Sketch1:circ1'])
    const constraints = constraints0(doc)
    const added = constraints.find(c => c.id.startsWith('c_normal'))
    expect(added).toBeDefined()
    expect(added!.a).toEqual('$line1')
    expect(added!.b).toEqual('$circ1')
  })

  it('stores a point-first line_distance line-first, keeping the value and sign', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(
      doc, 'Sketch1', 'line_distance',
      ['vertex:Sketch1:pt1:xy', 'entity:Sketch1:line1'], 5, undefined, -1,
    )
    const added = constraints0(doc).find(c => c.id.startsWith('c_line_distance'))
    expect(added).toBeDefined()
    // The solver and the renderer read `a` as the line; the pick order the
    // author used must not decide whether the row exists.
    expect(added!.a).toBe('$line1')
    expect(added!.b).toBe('$pt1xy')
    // A point/line swap must not flip the side: the same line measures it.
    expect(added!.value).toBe(5)
    expect(added!.sign).toBe(-1)
  })

  it('canonicalises a stored local point ref and a point entity first', () => {
    const localDoc = makeSampleDoc()
    applyAddConstraint(localDoc, 'Sketch1', 'line_distance', ['$pt1xy', '$line1'], 5)
    const local = constraints0(localDoc).find(c => c.id.startsWith('c_line_distance'))
    expect(local!.a).toBe('$line1')
    expect(local!.b).toBe('$pt1xy')

    const entityDoc = makeSampleDoc()
    applyAddConstraint(entityDoc, 'Sketch1', 'line_distance', ['entity:Sketch1:pt1', 'entity:Sketch1:line1'], 5)
    const entity = constraints0(entityDoc).find(c => c.id.startsWith('c_line_distance'))
    expect(entity!.a).toBe('$line1')
    expect(entity!.b).toBe('$pt1')
  })

  it('also canonicalises a builtin point first in a line_distance', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'line_distance', ['@builtin_origin', 'entity:Sketch1:line1'], 5)
    const added = constraints0(doc).find(c => c.id.startsWith('c_line_distance'))
    expect(added!.a).toBe('$line1')
    expect(added!.b).toBe('@builtin_origin')
  })

  it('canonicalises a curve-first line_distance', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'line_distance', ['entity:Sketch1:circ1', 'entity:Sketch1:line1'], 5)
    const added = constraints0(doc).find(c => c.id.startsWith('c_line_distance'))
    // The solver reads the non-line side through point(), so a circle is the
    // point side and the line belongs in `a`.
    expect(added!.a).toBe('$line1')
    expect(added!.b).toBe('$circ1')
  })

  it('keeps the two-line line_distance in pick order', () => {
    const doc = makeSampleDoc()
    entities0(doc).push({ id: 'line2', kind: 'line' })
    initial0(doc).line2 = [0, 5, 10, 5]
    applyAddConstraint(
      doc, 'Sketch1', 'line_distance',
      ['entity:Sketch1:line2', 'entity:Sketch1:line1'], 5,
    )
    const added = constraints0(doc).find(c => c.id.startsWith('c_line_distance'))
    // Only a vertex/builtin point in `a` with a line in `b` is repositioned;
    // the parallel line-line form is not a point-to-line dimension.
    expect(added!.a).toBe('$line2')
    expect(added!.b).toBe('$line1')
  })

  it('adds constraint with vertex point reference', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['vertex:Sketch1:line1:end', 'vertex:Sketch1:circ1:center'])
    const constraints = constraints0(doc)
    const added = constraints.find(c => c.id.startsWith('c_coincident'))
    expect(added).toBeDefined()
    expect(added!.a).toEqual('$line1end')
    expect(added!.b).toEqual('$circ1center')
  })

  it('generates unique constraint ids', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:circ1'])
    const ids = constraints0(doc).map((c: PartConstraint) => c.id)
    const vertIds = ids.filter((id: string) => id.startsWith('c_vertical'))
    expect(new Set(vertIds).size).toBe(vertIds.length)
  })

  it('adds constraint with value', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'length', ['entity:Sketch1:line1'], 42)
    const constraints = constraints0(doc)
    const added = constraints.find(c => c.id.startsWith('c_length'))
    expect(added!.value).toBe(42)
  })

  it('adds coincident constraint with @builtin_origin target', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'coincident', [
      'vertex:Sketch1:line1:start',
      '@builtin_origin',
    ])
    const constraints = constraints0(doc)
    const added = constraints.find(c => c.kind === 'coincident')
    expect(added).toBeDefined()
    expect(added!.a).toBe('$line1start')
    expect(added!.b).toBe('@builtin_origin')
  })

  it('horizontal with two vertices sets a and b refs', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'horizontal', ['vertex:Sketch1:line1:start', 'vertex:Sketch1:line1:end'])
    const constraints = constraints0(doc)
    const added = constraints.find(c => c.kind === 'horizontal' && c.a !== undefined)
    expect(added).toBeDefined()
    expect(added!.a).toBe('$line1start')
    expect(added!.b).toBe('$line1end')
    expect(added!.target).toBeUndefined()
  })

  it('vertical with two vertices sets a and b refs', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['vertex:Sketch1:line1:start', 'vertex:Sketch1:line1:end'])
    const constraints = constraints0(doc)
    const added = constraints.find(c => c.kind === 'vertical' && c.a !== undefined)
    expect(added).toBeDefined()
    expect(added!.a).toBe('$line1start')
    expect(added!.b).toBe('$line1end')
    expect(added!.target).toBeUndefined()
  })

  it('horizontal with single line target uses target ref', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'horizontal', ['entity:Sketch1:line1'])
    const constraints = constraints0(doc)
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
    const constraints = constraints0(doc)
    expect(constraints.find(c => c.kind === 'vertical')).toBeUndefined()
  })

  it('horizontal with an entity in the a/b slot is rejected', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'horizontal', ['vertex:Sketch1:line1:start', 'entity:Sketch1:circ1'])
    const constraints = constraints0(doc)
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
    const constraints = constraints0(doc)
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
    const constraints = constraints0(doc)
    const added = constraints.find(c => c.kind === 'midpoint')
    expect(added).toBeDefined()
    expect(added!.point_a).toBe('$line1start')
    expect(added!.point_b).toBe('$line1end')
    expect(added!.point).toBe('$pt1xy')
  })

  it('unrecognized target combo does not add constraint and calls console.warn in dev mode', () => {
    const doc = makeSampleDoc()
    const countBefore = constraints0(doc).length
    // Two entity targets, not a recognized midpoint pattern
    applyAddConstraint(doc, 'Sketch1', 'midpoint', [
      'entity:Sketch1:line1',
      'entity:Sketch1:circ1',
    ])
    expect(constraints0(doc).length).toBe(countBefore)
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
    const countBefore = constraints0(doc).length
    applyAddConstraint(doc, 'Sketch1', 'parallel', [])
    expect(constraints0(doc).length).toBe(countBefore)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('parallel'),
      expect.anything(),
    )
  })

  it('coincident with a single target is rejected rather than authored half-picked', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['entity:Sketch1:circ1'])
    expect(constraints0(doc).find(c => c.kind === 'coincident')).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('coincident'),
      expect.anything(),
    )
  })

  it('a valid two-target coincident still adds', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'coincident', ['vertex:Sketch1:line1:end', 'vertex:Sketch1:circ1:center'])
    const added = constraints0(doc).find(c => c.kind === 'coincident')
    expect(added).toBeDefined()
    expect(added!.a).toEqual('$line1end')
    expect(added!.b).toEqual('$circ1center')
  })

  it('a single-target generic kind keeps its target form', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'length', ['entity:Sketch1:line1'], 42)
    const added = constraints0(doc).find(c => c.kind === 'length')
    expect(added).toBeDefined()
    expect(added!.target).toBe('$line1')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // L19: the h/v branch had no min-guard of its own, so an empty pick fell
  // through both the a/b and target forms and authored an operand-less
  // constraint (latent behind the store's empty-selection gate). It must
  // behave exactly like the generic kinds above.
  it('an axis kind with no targets adds nothing and warns', () => {
    const doc = makeSampleDoc()
    const countBefore = constraints0(doc).length
    applyAddConstraint(doc, 'Sketch1', 'horizontal', [])
    applyAddConstraint(doc, 'Sketch1', 'vertical', [])
    expect(constraints0(doc).length).toBe(countBefore)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('horizontal'),
      expect.anything(),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('vertical'),
      expect.anything(),
    )
  })
})

describe('applySetConstraintPos', () => {
  it('sets pos on an existing constraint', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_len', [3.5, -2.0])
    const c = constraints0(doc).find(c => c.id === 'c_len')
    expect(c!.pos).toEqual([3.5, -2.0])
  })

  it('rounds pos to 6 decimal places', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_len', [1.23456789, -9.87654321])
    const c = constraints0(doc).find(c => c.id === 'c_len')
    expect(c!.pos![0]).toBe(1.234568)
    expect(c!.pos![1]).toBe(-9.876543)
  })

  it('no-ops for unknown constraint', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_nonexistent', [1, 2])
    // No pos set on any constraint
    for (const c of constraints0(doc)) {
      expect(c.pos).toBeUndefined()
    }
  })

  it('no-ops for unknown feature', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'NoSuchFeature', 'c_len', [1, 2])
    const c = constraints0(doc).find(c => c.id === 'c_len')
    expect(c!.pos).toBeUndefined()
  })

  it('ignores a non-finite pos instead of persisting NaN into the document', () => {
    const doc = makeSampleDoc()
    applySetConstraintPos(doc, 'Sketch1', 'c_len', [NaN, Infinity])
    expect(constraints0(doc).find(c => c.id === 'c_len')!.pos).toBeUndefined()
  })
})

const docWithSketch = (id: string): PartDoc => ({
  version: 1, kind: 'part',
  features: [{ id, kind: 'sketch', entities: [{ id: 'lineA', kind: 'line' }], initial: { lineA: [0,0,10,0] }, constraints: [] }],
})

// applyAddConstraint stores face query verbatim
describe('applyAddConstraint with face target', () => {
  it('stores face ancestry query verbatim as constraint field', () => {
    const doc = docWithSketch('sketch1')
    applyAddConstraint(doc, 'sketch1', 'coincident',
      ['vertex:sketch1:lineA:start', 'face:sketch0:?3;@sketch0abc'])
    const c = constraints0(doc)[0]
    expect(c.b).toBe('?3;@sketch0abc')
  })

  it('stores face query with type restriction verbatim', () => {
    const doc = docWithSketch('sketch1')
    applyAddConstraint(doc, 'sketch1', 'coincident',
      ['vertex:sketch1:lineA:start', 'face:sketch0:?9,9;@sketch0la@sketch0lb:face'])
    const c = constraints0(doc)[0]
    expect(c.b).toBe('?9,9;@sketch0la@sketch0lb:face')
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
    expect(constraints0(doc)).toHaveLength(0)
  })

  it('removes a horizontal whose single operand is a whole entity', () => {
    const doc = docWithDeadVertical()
    sketchAt(doc).constraints = [
      { id: 'c_dead', kind: 'horizontal', a: '$circ1', b: '$pt1' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(1)
    expect(constraints0(doc)).toHaveLength(0)
  })

  // A whole-entity ref whose id ends with a vertex key must not be read as that
  // other entity's sub-point. Here `$line1end` names the line entity `line1end`;
  // the suffix reading would mistake it for `line1`'s end vertex and keep the
  // degenerate constraint.
  it('removes a vertical over a whole entity whose id ends with a vertex key', () => {
    const doc = docWithDeadVertical()
    entities0(doc).push({ id: 'line1end', kind: 'line' })
    initial0(doc)['line1end'] = [1, 1, 2, 2]
    sketchAt(doc).constraints = [
      { id: 'c_dead', kind: 'vertical', a: '$line1end', b: '$pt1' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(1)
    expect(constraints0(doc)).toHaveLength(0)
  })

  it('keeps a valid two-point vertical (point entity + line endpoint)', () => {
    const doc = docWithDeadVertical()
    sketchAt(doc).constraints = [
      { id: 'c_ok', kind: 'vertical', a: '$pt1', b: '$line1start' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(0)
    expect(constraints0(doc)).toHaveLength(1)
  })

  it('keeps a valid two-point vertical between two point entities', () => {
    const doc = docWithDeadVertical()
    sketchAt(doc).constraints = [
      { id: 'c_ok', kind: 'vertical', a: '$pt1', b: '$pt2' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(0)
    expect(constraints0(doc)).toHaveLength(1)
  })

  it('keeps the single-line target form (no a/b)', () => {
    const doc = docWithDeadVertical()
    sketchAt(doc).constraints = [
      { id: 'c_ok', kind: 'horizontal', target: '$line1' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(0)
    expect(constraints0(doc)).toHaveLength(1)
  })

  it('leaves non-axis constraints untouched', () => {
    const doc = docWithDeadVertical()
    sketchAt(doc).constraints = [
      { id: 'c_coin', kind: 'coincident', a: '$circ1', b: '$line1' },
    ]
    expect(dropDeadAxisConstraints(doc)).toBe(0)
    expect(constraints0(doc)).toHaveLength(1)
  })
})

describe('constraint dimension value stored precision', () => {
  it('stores an add_constraint value of 0.3125 exactly', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'length', ['entity:Sketch1:line1'], 0.3125)
    const added = constraints0(doc).find(c => c.id.startsWith('c_length'))
    expect(added!.value).toBe(0.3125)
  })

  it('stores a set_constraint_value of 0.03125 exactly', () => {
    const doc = makeSampleDoc()
    applySetConstraintValue(doc, 'Sketch1', 'c_len', 0.03125)
    const c = constraints0(doc).find(c => c.id === 'c_len')
    expect(c!.value).toBe(0.03125)
  })

  it('rounds a set_constraint_value to the 1e-6 document grid', () => {
    const doc = makeSampleDoc()
    applySetConstraintValue(doc, 'Sketch1', 'c_len', 0.1234567)
    const c = constraints0(doc).find(c => c.id === 'c_len')
    expect(c!.value).toBe(0.123457)
  })

  it('ignores a non-finite set_constraint_value', () => {
    const doc = makeSampleDoc()
    applySetConstraintValue(doc, 'Sketch1', 'c_len', NaN)
    const c = constraints0(doc).find(c => c.id === 'c_len')
    expect(c!.value).toBe(10)
  })

  it('keeps an angle constraint value of 22.5 exact', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'angle', ['entity:Sketch1:line1'], 22.5)
    const added = constraints0(doc).find(c => c.kind === 'angle')
    expect(added!.value).toBe(22.5)
  })

  it('still ignores a non-finite add_constraint value', () => {
    const doc = makeSampleDoc()
    applyAddConstraint(doc, 'Sketch1', 'length', ['entity:Sketch1:line1'], NaN)
    const added = constraints0(doc).find(c => c.id.startsWith('c_length'))
    // The value is dropped at the boundary, not rounded into the document; the
    // constraint itself is still authored as a value-less dimension.
    expect(added).toBeDefined()
    expect('value' in added!).toBe(false)
  })
})

describe('point_distance value 0', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  const zeroDoc = (): PartDoc => ({
    version: 1,
    kind: 'part',
    features: [{
      id: 'Sketch1',
      kind: 'sketch',
      initial: { pt1: [0, 0], pt2: [1, 0] },
      entities: [{ id: 'pt1', kind: 'point' }, { id: 'pt2', kind: 'point' }],
      constraints: [{ id: 'c_dist', kind: 'point_distance', a: '$pt1', b: '$pt2', value: 5 }],
    }],
  })

  // A zero euclidean distance asks for two coincident points: two equations
  // that one row cannot express, so authoring it would leave the DOF free.
  it('refuses to author a zero euclidean point_distance and names coincident', () => {
    const doc = zeroDoc()
    applyAddConstraint(doc, 'Sketch1', 'point_distance', ['entity:Sketch1:pt1', 'entity:Sketch1:pt2'], 0)
    expect(constraints0(doc).filter(c => c.kind === 'point_distance')).toHaveLength(1)
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('coincident')
  })

  it('refuses a value that rounds to zero on the document grid', () => {
    const doc = zeroDoc()
    applyAddConstraint(doc, 'Sketch1', 'point_distance', ['entity:Sketch1:pt1', 'entity:Sketch1:pt2'], 1e-9)
    expect(constraints0(doc).filter(c => c.kind === 'point_distance')).toHaveLength(1)
  })

  it('refuses to set an existing point_distance to zero and keeps the old value', () => {
    const doc = zeroDoc()
    applySetConstraintValue(doc, 'Sketch1', 'c_dist', 0)
    expect(constraints0(doc).find(c => c.id === 'c_dist')!.value).toBe(5)
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('coincident')
  })

  // The axis kinds keep an analytic row at the kink, so their zero stays
  // authorable.
  it('still authors a zero point_distance_x', () => {
    const doc = zeroDoc()
    applyAddConstraint(doc, 'Sketch1', 'point_distance_x', ['entity:Sketch1:pt1', 'entity:Sketch1:pt2'], 0)
    expect(constraints0(doc).some(c => c.kind === 'point_distance_x' && c.value === 0)).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
