import { describe, it, expect } from 'vitest'
import type { PartFeature, PartConstraint } from '@/types/cad'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'
import { partDocToSketches } from './partDocToSketches'

describe('partDocToSketches', () => {
  it('resolves $-form sketch-local refs to dict form', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [
          { id: 'bottom', kind: 'line' },
          { id: 'right', kind: 'line' },
        ],
        initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 10] },
        constraints: [
          { id: 'c1', kind: 'coincident', a: '$bottomend', b: '$rightstart' },
          { id: 'c2', kind: 'horizontal', target: '$bottom' },
          { id: 'c3', kind: 'length', target: '$bottom', value: 10 },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches).toHaveLength(1)
    const c = sketches[0].sketch.constraints
    expect(c[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'bottom', point: 'end' },
      b: { entity: 'right', point: 'start' },
    })
    expect(c[1]).toMatchObject({ kind: 'horizontal', target: { entity: 'bottom' } })
    expect(c[2]).toMatchObject({ kind: 'length', target: { entity: 'bottom' }, value: 10 })
  })

  it('disambiguates a minted base64url id ending in a vertex-key word by full-id membership', () => {
    // wire-format-hardening (B1): a minted bare id can itself end in a
    // pure-word suffix. A ref whose FULL string names a known entity resolves
    // as that whole id; a ref whose residual alone names a known entity (the
    // `$pwfYD59xKWiSyQhmcenter` sub-point shape) resolves as eid + point.
    const b64 = 'k-g9YNviFC85Z-7Kxy'
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: b64, kind: 'line' }, { id: 'pwfYD59xKWiSyQhm', kind: 'line' }],
        initial: { [b64]: [0, 0, 10, 0], pwfYD59xKWiSyQhm: [10, 0, 10, 10] },
        constraints: [
          { id: 'c_bare', kind: 'horizontal', target: `$${b64}` },
          { id: 'c_sub', kind: 'coincident', a: '$pwfYD59xKWiSyQhmcenter', b: '@builtin_origin' },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    const cs = sketches[0].sketch.constraints
    expect(cs).toHaveLength(2)
    expect(cs[0]).toMatchObject({ kind: 'horizontal', target: { entity: b64 } })
    expect(cs[1]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'pwfYD59xKWiSyQhm', point: 'center' },
    })
  })

  it('drops constraints whose refs do not resolve locally (mirrors historical behavior)', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'p1', kind: 'point' }],
        initial: { p1: [0, 0] },
        constraints: [
          { id: 'keep', kind: 'fixed', target: '$p1', x: 0, y: 0 },
          // references a non-local / ancestral entity -> dropped
          { id: 'drop', kind: 'coincident', a: '$p1', b: '$nonexistentstart' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features)
    const ids = sketches[0].sketch.constraints.map((c) => c.id)
    expect(ids).toEqual(['keep'])
  })

  it('skips projection and center_rect sketches', () => {
    const features: PartFeature[] = [
      {
        id: 'proj',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line', source: '@sketch0/line1' }],
        initial: {},
        constraints: [],
      },
      {
        id: 'sugar',
        kind: 'sketch',
        entities: [{ id: 'r1', kind: 'center_rect' }],
        initial: {},
        constraints: [],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(sketches).toHaveLength(0)
    expect(skipped.map((s) => s.featureId).sort()).toEqual(['proj', 'sugar'])
  })

  it('resolves @builtin_origin to external_xy:[0,0]', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'c1', kind: 'circle' }],
        initial: { c1: [0, 0, 5] },
        constraints: [
          { id: 'c_coincident', kind: 'coincident', a: '$c1center', b: '@builtin_origin' },
          { id: 'c_diameter', kind: 'diameter', target: '$c1', value: 10 },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches).toHaveLength(1)
    const c = sketches[0].sketch.constraints
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'c1', point: 'center' },
      b: { external_xy: [0, 0] },
    })
    expect(c[1]).toMatchObject({ kind: 'diameter', target: { entity: 'c1' }, value: 10 })
  })

  it('resolves @builtin_origin to the projected originLocal on an offset plane', () => {
    // On a sketch whose plane does not pass through the document origin, the
    // origin lives at nonzero local 2D coords. The lowering must carry those, or
    // a coincident-to-origin pins to the plane's local (0,0) -- a different 3D
    // point ("line constrained to origin" bug).
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'c1', kind: 'circle' }],
        initial: { c1: [0, 0, 5] },
        constraints: [
          { id: 'c_coincident', kind: 'coincident', a: '$c1center', b: '@builtin_origin' },
        ],
      },
    ]
    const { sketches } = partDocToSketches(features, [3, -7])
    expect(sketches[0].sketch.constraints[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'c1', point: 'center' },
      b: { external_xy: [3, -7] },
    })
  })

  it('expands an ngon sugar constraint to equal_length + angle (not dropped)', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [
          { id: 'l0', kind: 'line' }, { id: 'l1', kind: 'line' },
          { id: 'l2', kind: 'line' }, { id: 'l3', kind: 'line' },
        ],
        initial: { l0: [1, 0, 0, 1], l1: [0, 1, -1, 0], l2: [-1, 0, 0, -1], l3: [0, -1, 1, 0] },
        constraints: [
          { id: 'ng', kind: 'ngon', refs: ['$l0', '$l1', '$l2', '$l3'] },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    const cs = sketches[0].sketch.constraints
    // 4 sides -> 3 equal_length + (4-3)=1 angle; no raw `ngon` survives.
    expect(cs.filter((c) => c.kind === 'ngon')).toHaveLength(0)
    expect(cs.filter((c) => c.kind === 'equal_length')).toHaveLength(3)
    const angles = cs.filter((c) => c.kind === 'angle')
    expect(angles).toHaveLength(1)
    expect(angles[0]).toMatchObject({ value: 90, a: { entity: 'l0' }, b: { entity: 'l1' } })
    expect(cs[0]).toMatchObject({ kind: 'equal_length', a: { entity: 'l0' }, b: { entity: 'l1' } })
  })

  // A hexagon with its construction circumcircle, in the stored wire form.
  function centeredHexagon(withCircle: boolean): PartFeature[] {
    const ids = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5']
    const initial: Record<string, number[]> = { circ: [0, 0, 10] }
    ids.forEach((id, i) => {
      const a1 = (i / 6) * 2 * Math.PI, a2 = ((i + 1) / 6) * 2 * Math.PI
      initial[id] = [10 * Math.cos(a1), 10 * Math.sin(a1), 10 * Math.cos(a2), 10 * Math.sin(a2)]
    })
    const ngon: PartConstraint = { id: 'ng', kind: 'ngon', refs: ids.map(id => `$${id}`) }
    if (withCircle) ngon.circle = '$circ'
    return [{
      id: 'sk1',
      kind: 'sketch',
      entities: [...ids.map(id => ({ id, kind: 'line' })), { id: 'circ', kind: 'circle', construction: true }],
      initial,
      constraints: [ngon],
    }]
  }

  it('an ngon with a circle lowers to the old primitives plus three vertex-on-circle pins', () => {
    const cs = partDocToSketches(centeredHexagon(true)).sketches[0].sketch.constraints
    expect(cs.filter((c) => c.kind === 'equal_length')).toHaveLength(5)
    expect(cs.filter((c) => c.kind === 'angle')).toHaveLength(3)
    const pins = cs.filter((c) => c.kind === 'coincident')
    // Three concyclic points fix a circle: spread over the polygon (0, N/3, 2N/3)
    // so the pins stay well conditioned.
    expect(pins).toEqual([
      { id: 'ng_on0', kind: 'coincident', a: { entity: 'l0', point: 'start' }, b: { entity: 'circ' } },
      { id: 'ng_on1', kind: 'coincident', a: { entity: 'l2', point: 'start' }, b: { entity: 'circ' } },
      { id: 'ng_on2', kind: 'coincident', a: { entity: 'l4', point: 'start' }, b: { entity: 'circ' } },
    ])
  })

  it('a triangle pins all three of its vertices', () => {
    const features: PartFeature[] = [{
      id: 'sk1',
      kind: 'sketch',
      entities: [{ id: 'a', kind: 'line' }, { id: 'b', kind: 'line' }, { id: 'c', kind: 'line' }, { id: 'o', kind: 'circle' }],
      initial: { a: [1, 0, 0, 1], b: [0, 1, -1, 0], c: [-1, 0, 1, 0], o: [0, 0, 1] },
      constraints: [{ id: 'ng', kind: 'ngon', refs: ['$a', '$b', '$c'], circle: '$o' }],
    }]
    const pins = partDocToSketches(features).sketches[0].sketch.constraints.filter((c) => c.kind === 'coincident')
    expect(pins.map((c) => (c.a as { entity: string }).entity)).toEqual(['a', 'b', 'c'])
  })

  it('an ngon without a circle (an old document) lowers exactly as before', () => {
    const withOut = partDocToSketches(centeredHexagon(false)).sketches[0].sketch.constraints
    expect(withOut.map((c) => c.kind)).toEqual([
      ...Array(5).fill('equal_length'), ...Array(3).fill('angle'),
    ])
  })

  it('a circle ref that no longer resolves drops only the pins', () => {
    const features = centeredHexagon(true)
    features[0].entities = features[0].entities!.filter((e) => e.id !== 'circ')
    const cs = partDocToSketches(features).sketches[0].sketch.constraints
    expect(cs.map((c) => c.kind)).toEqual([
      ...Array(5).fill('equal_length'), ...Array(3).fill('angle'),
    ])
  })

  it('expands a dock constraint to two coincident-to-locus pins against its host', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [
          { id: 'circA', kind: 'circle' }, { id: 'circB', kind: 'circle' },
          { id: 'pt', kind: 'point' },
        ],
        initial: { circA: [0, 0, 5], circB: [10, 0, 5], pt: [5, 0] },
        constraints: [
          { id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' },
          { id: 'dk', kind: 'dock', point: '$ptxy', host: 'tan' },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    const cs = sketches[0].sketch.constraints
    // The tangent survives; the dock becomes two coincidents pinning pt to each
    // curve as a locus (no vertex key on the curve operand). No raw `dock`.
    expect(cs.filter((c) => c.kind === 'dock')).toHaveLength(0)
    expect(cs.filter((c) => c.kind === 'tangent')).toHaveLength(1)
    const coincidents = cs.filter((c) => c.kind === 'coincident')
    expect(coincidents).toHaveLength(2)
    expect(coincidents[0]).toMatchObject({ a: { entity: 'pt', point: 'xy' }, b: { entity: 'circA' } })
    expect(coincidents[1]).toMatchObject({ a: { entity: 'pt', point: 'xy' }, b: { entity: 'circB' } })
    // Locus form: the curve operand carries NO point key.
    expect((coincidents[0].b as { point?: string }).point).toBeUndefined()
  })

  it('drops a dock whose host constraint is gone (fail-soft float)', () => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [
          { id: 'circA', kind: 'circle' }, { id: 'circB', kind: 'circle' },
          { id: 'pt', kind: 'point' },
        ],
        initial: { circA: [0, 0, 5], circB: [10, 0, 5], pt: [5, 0] },
        constraints: [
          // host 'tan' was deleted; the dangling dock lowers to nothing so pt
          // floats as an ordinary under-constrained point.
          { id: 'dk', kind: 'dock', point: '$ptxy', host: 'tan' },
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints).toHaveLength(0)
  })

  it('drops a constraint whose dict ref carries a point name outside VERTEX_POINT_KEYS', () => {
    // A typo'd dict point must not ride through: downstream lowering maps an
    // unknown name to Sel.absent, which the Rust solver reads as whole-curve
    // locus, quietly turning an endpoint-to-point coincident into
    // point-on-curve. Dropped like any other unresolvable ref instead.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
        constraints: [
          { id: 'keep', kind: 'horizontal', target: '$l1' },
          { id: 'drop', kind: 'coincident', a: { entity: 'l1', point: 'strt' }, b: '@builtin_origin' } as unknown as PartConstraint,
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints.map((c) => c.id)).toEqual(['keep'])
  })

  it('drops a constraint whose dict ref carries a non-string point value', () => {
    // A truthy non-string point is present but not a VERTEX_POINT_KEYS member,
    // so it drops like any other unresolvable ref rather than degrading to
    // bare locus.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
        constraints: [
          { id: 'keep', kind: 'horizontal', target: '$l1' },
          { id: 'drop', kind: 'coincident', a: { entity: 'l1', point: 3 }, b: '@builtin_origin' } as unknown as PartConstraint,
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints.map((c) => c.id)).toEqual(['keep'])
  })

  it('drops a whole constraint whose present scalar is non-numeric', () => {
    // A present-but-bad scalar must not be stripped and the constraint kept: the
    // Rust side reads a dimension with no value as no residual, so the sketch
    // would silently solve underconstrained. A half-authored x/y pair is the
    // same corruption. All of these drop, mirroring the unresolvable-ref path.
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
        constraints: [
          { id: 'keep', kind: 'horizontal', target: '$l1' },
          { id: 'drop_value', kind: 'length', target: '$l1', value: 'ten' } as unknown as PartConstraint,
          { id: 'drop_xy', kind: 'fixed', target: '$l1', x: 1 } as unknown as PartConstraint,
          { id: 'drop_axis', kind: 'fixed', target: '$l1', axis: 4 } as unknown as PartConstraint,
          { id: 'drop_sign', kind: 'distance', target: '$l1', sign: 'plus' } as unknown as PartConstraint,
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints.map((c) => c.id)).toEqual(['keep'])
  })

  it.each([...VERTEX_POINT_KEYS])('passes dict-ref point %s through unchanged', (pt) => {
    const features: PartFeature[] = [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
        constraints: [
          { id: 'c', kind: 'coincident', a: { entity: 'l1', point: pt }, b: '@builtin_origin' } as unknown as PartConstraint,
        ],
      },
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(skipped).toHaveLength(0)
    expect(sketches[0].sketch.constraints[0]).toMatchObject({
      kind: 'coincident',
      a: { entity: 'l1', point: pt },
    })
  })

  it('ignores non-sketch features', () => {
    const features: PartFeature[] = [
      { id: 'ex1', kind: 'extrude', extrude: undefined } as unknown as PartFeature,
    ]
    const { sketches, skipped } = partDocToSketches(features)
    expect(sketches).toHaveLength(0)
    expect(skipped).toHaveLength(0)
  })
})
