import { describe, it, expect } from 'vitest'
import { lowerSketch, pinnedMaskFor, type EntityLayout } from '../lowerSketch'
import { ConstraintKindCode, Kind, Role, Sel } from '../codec'
import { DOC_GRID, round } from '@/utils/yamlMutations/helpers'

describe('lowerSketch storage quantum', () => {
  it('sends the grid the document mutators round to, so the moved report matches storage', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'e1', kind: 'line' }],
      initial: { e1: [0, 0, 1, 0] },
      constraints: [],
    })
    expect(input.seedQuantum).toBe(DOC_GRID)
    // The two spellings must stay one grid: a value halfway between two stored
    // values rounds to one of them, and a quantum elsewhere would report a move
    // the document cannot write.
    expect(round(2 * DOC_GRID + DOC_GRID / 2)).toBe(3 * DOC_GRID)
  })
})

describe('lowerSketch ellipse entity', () => {
  it('lays out an ellipse as 5 params with kind code 4', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'e1', kind: 'ellipse' }],
      initial: { e1: [1, 2, 4, 2, 30] },
      constraints: [],
    })

    // Layout: the ellipse, then the injected origin point.
    const el = layout.find(l => l.id === 'e1')!
    expect(el.kind).toBe('ellipse')
    expect(el.size).toBe(5)
    expect(el.offset).toBe(0)

    // Flat entity carries solver kind code 4 (Kind.Ellipse).
    expect(input.entities[0].kind).toBe(Kind.Ellipse)
    expect(input.entities[0].kind).toBe(4)

    // The 5 ellipse params come first, then the origin's 2 params (0, 0).
    expect(input.params.slice(0, 5)).toEqual([1, 2, 4, 2, 30])
    expect(input.params.slice(5)).toEqual([0, 0])
  })

  it('point-on-ellipse coincident lowers with the ellipse as ref b', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [
        { id: 'p1', kind: 'point' },
        { id: 'e1', kind: 'ellipse' },
      ],
      initial: { p1: [5, 0], e1: [0, 0, 4, 2, 0] },
      constraints: [{ kind: 'coincident', a: { entity: 'p1', point: 'xy' }, b: { entity: 'e1' } }],
    })
    // The coincident lowered without throwing on the ellipse ref; lowerSketch
    // also appends the implicit origin pin, so there are two constraints.
    expect(input.constraints).toHaveLength(2)
    const coincident = input.constraints[0]
    expect(coincident.kind).toBe(6)  // coincident

    // The solver's point-on-ellipse branch keys on ref b being the ellipse with
    // no point selector; ref a being the point. Assert the exact roles/indices/
    // selectors so a swapped or mis-selected ref (which would silently fall back
    // to point-point distance) is caught here.
    const a = coincident.refs.find(r => r.role === Role.a)!
    const b = coincident.refs.find(r => r.role === Role.b)!
    expect(a.ref).toEqual({ kind: 'entity', index: 0, point: Sel.xy })       // p1
    expect(b.ref).toEqual({ kind: 'entity', index: 1, point: Sel.absent })   // e1, no selector
    expect(input.params.slice(2, 7)).toEqual([0, 0, 4, 2, 0])  // ellipse block
  })

  it('lowers a center->major1 point_distance to the major-axis Sel code', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'e1', kind: 'ellipse' }],
      initial: { e1: [0, 0, 4, 2, 0] },
      constraints: [{
        kind: 'point_distance',
        a: { entity: 'e1', point: 'center' },
        b: { entity: 'e1', point: 'major1' },
        value: 4,
      }],
    })
    const pd = input.constraints.find(c => c.kind === 12)!  // point_distance
    const a = pd.refs.find(r => r.role === Role.a)!
    const b = pd.refs.find(r => r.role === Role.b)!
    expect(a.ref).toEqual({ kind: 'entity', index: 0, point: Sel.center })
    expect(b.ref).toEqual({ kind: 'entity', index: 0, point: Sel.major })  // code 5
    expect(pd.value).toBe(4)
  })
})

describe('lowerSketch fails loud on malformed refs', () => {
  it('throws naming an unknown point selector instead of silently mapping it to Sel.absent', () => {
    // Sel.absent means whole-curve locus to the Rust solver, so a typo'd
    // selector must never degrade into that semantics.
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0] },
      constraints: [{ kind: 'coincident', a: { entity: 'l1', point: 'strt' }, b: '@builtin_origin' }],
    })).toThrow("lowerSketch: unknown point selector 'strt'")
  })

  it('throws naming an unknown axis string instead of dropping the axis flag', () => {
    // An unencoded axis lowered to undefined, so the flag was never set and the
    // Rust decoder saw axis=None past its own BadAxis guard.
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0] },
      constraints: [{ kind: 'horizontal', target: { entity: 'l1' }, axis: 'diagonal' }],
    })).toThrow("lowerSketch: unknown axis 'diagonal'")
  })

  it('rejects a raw query-string ref instead of hardcoding @builtin_origin to external [0,0]', () => {
    // The old shortcut pinned the DOCUMENT origin at [0,0] in sketch-local
    // coords, silently wrong for an offset plane. Resolution (and originLocal)
    // belongs to partDocToSketches; a string reaching this layer is a bypassed
    // resolver and must be loud, not a silent [0,0] pin.
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0] },
      constraints: [{ kind: 'coincident', a: { entity: 'l1', point: 'start' }, b: '@builtin_origin' }],
    })).toThrow(/@builtin_origin/)
  })

  it('lowers an external_xy dict ref as external with its own coordinates', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0] },
      constraints: [{ kind: 'coincident', a: { entity: 'l1', point: 'start' }, b: { external_xy: [3, -2] } }],
    })
    const coincident = input.constraints[0]
    const b = coincident.refs.find(r => r.role === Role.b)!
    expect(b.ref).toEqual({ kind: 'external', x: 3, y: -2 })
  })

  it('throws naming an unknown constraint kind instead of dropping it silently', () => {
    // `colinear` used to reach this layer and vanish through a `return null`:
    // no dropped verdict, no warning, no residual. partDocToSketches now lowers
    // every document kind first, so a kind that arrives here unknown is a
    // programming error and must be loud.
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0], l2: [0, 1, 10, 1] },
      constraints: [{ kind: 'colinear', a: { entity: 'l1' }, b: { entity: 'l2' } }],
    })).toThrow("lowerSketch: unknown constraint kind 'colinear'")
  })

  it('rejects an inherited Object key as a constraint kind', () => {
    // The kind table is a plain object, so 'toString' would resolve through the
    // prototype to a function and pass a bare undefined check, then encode as
    // whichever byte the coercion produced.
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0] },
      constraints: [{ kind: 'toString', a: { entity: 'l1' } }],
    })).toThrow("lowerSketch: unknown constraint kind 'toString'")
  })

  it('throws naming an unknown entity kind instead of laying it out as a zero-param Line', () => {
    // An unknown kind left size undefined: the layout arithmetic went NaN and
    // the kind byte encoded as 0, which the Rust decoder reads as a Line.
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'x1', kind: 'hexagon' }],
      initial: {},
      constraints: [],
    })).toThrow("lowerSketch: unknown entity kind 'hexagon'")
  })

  it('rejects an inherited Object key as an entity kind', () => {
    // ENTITY_SIZES is a plain table, so 'toString' would resolve through the
    // prototype to a function and pass a bare undefined check.
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'x1', kind: 'toString' }],
      initial: {},
      constraints: [],
    })).toThrow("lowerSketch: unknown entity kind 'toString'")
  })
})

describe('pinnedMaskFor (projected-entity pinning)', () => {
  // Two lines (4 params each) then a circle (3): flat params 0..10, the origin
  // appended by lowerSketch is irrelevant to the helper which only sees layout.
  const layout: EntityLayout[] = [
    { id: 'a', kind: 'line', offset: 0, size: 4, flags: 0 },
    { id: 'b', kind: 'line', offset: 4, size: 4, flags: 0 },
    { id: 'c', kind: 'circle', offset: 8, size: 3, flags: 0 },
  ]
  const nParams = 11

  it('returns [] when nothing is pinned (byte-identical to the old hardcoded [])', () => {
    expect(pinnedMaskFor(layout, [], nParams)).toEqual([])
    // An id that is not in the layout pins nothing.
    expect(pinnedMaskFor(layout, ['zzz'], nParams)).toEqual([])
  })

  it('sets one LSB-first bit per param of a pinned entity', () => {
    // Pin entity 'b' (offset 4, size 4): bits 4,5,6,7 -> high nibble of byte 0.
    const mask = pinnedMaskFor(layout, ['b'], nParams)
    expect(mask).toEqual([0b1111_0000, 0b0000_0000])
  })

  it('pins params spanning a byte boundary', () => {
    // Pin 'c' (offset 8, size 3): bits 8,9,10 -> low three bits of byte 1.
    expect(pinnedMaskFor(layout, ['c'], nParams)).toEqual([0b0000_0000, 0b0000_0111])
  })

  it('ORs multiple pinned entities into the same mask', () => {
    // 'a' (bits 0..3) + 'c' (bits 8..10).
    expect(pinnedMaskFor(layout, ['a', 'c'], nParams)).toEqual([0b0000_1111, 0b0000_0111])
  })

  it('lowerSketch wires pinnedEntityIds into input.pinnedMask', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'p', kind: 'circle' }, { id: 'q', kind: 'line' }],
      initial: { p: [1, 2, 3], q: [0, 0, 1, 1] },
      constraints: [],
      pinnedEntityIds: ['p'],  // circle: bits 0,1,2
    })
    // params: circle(3) + line(4) + origin(2) = 9 -> ceil(9/8) = 2 bytes.
    expect(input.pinnedMask).toEqual([0b0000_0111, 0b0000_0000])
  })

  it('lowerSketch leaves pinnedMask empty when no ids are pinned', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'p', kind: 'circle' }],
      initial: { p: [1, 2, 3] },
      constraints: [],
    })
    expect(input.pinnedMask).toEqual([])
  })
})

describe('lowerSketch fit_spline entity', () => {
  it('lays out the variable block and flags without handles', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'sp', kind: 'fit_spline' }],
      initial: { sp: [0, 0, 1, 2, 3, 1] },
      constraints: [],
    })
    const ent = layout.find(l => l.id === 'sp')!
    expect(ent.kind).toBe('fit_spline')
    expect(ent.size).toBe(6)
    expect(ent.flags).toBe(0)
    expect(input.entities[0]).toMatchObject({ kind: Kind.FitSpline, flags: 0, offset: 0, count: 6 })
    expect(input.params.slice(0, 6)).toEqual([0, 0, 1, 2, 3, 1])
  })

  it('lays out both handles after the fit points and sets the flag bits', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'sp', kind: 'fit_spline', handles: 'both' }],
      initial: { sp: [0, 0, 1, 2, 3, 1, 4, 4, 5, 5] },
      constraints: [],
    })
    expect(layout.find(l => l.id === 'sp')!.size).toBe(10)
    expect(input.entities[0]).toMatchObject({ kind: Kind.FitSpline, flags: 3, count: 10 })
    expect(input.params.slice(0, 10)).toEqual([0, 0, 1, 2, 3, 1, 4, 4, 5, 5])
  })

  it('encodes fit<k> as the 32 + k selector', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'sp', kind: 'fit_spline' }],
      initial: { sp: [0, 0, 1, 2, 3, 1] },
      constraints: [{ id: 'c1', kind: 'coincident', a: { entity: 'sp', point: 'fit1' }, b: { external_xy: [0, 0] } }],
    })
    const ref = input.constraints[0].refs[0].ref
    expect(ref).toEqual({ kind: 'entity', index: 0, point: 33 })
  })

  it('fails loud on an odd or short initial block', () => {
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'sp', kind: 'fit_spline' }],
      initial: { sp: [0, 0, 1, 2, 3] },
      constraints: [],
    })).toThrow(/fit_spline 'sp'/)
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'sp', kind: 'fit_spline' }],
      initial: { sp: [0, 0] },
      constraints: [],
    })).toThrow(/fit_spline 'sp'/)
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'sp', kind: 'fit_spline' }],
      initial: {},
      constraints: [],
    })).toThrow(/fit_spline 'sp'/)
  })

  it('rejects a 65-point block', () => {
    const params = Array.from({ length: 65 }, (_, i) => [i, i]).flat()
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'sp', kind: 'fit_spline' }],
      initial: { sp: params },
      constraints: [],
    })).toThrow(/limit is 64/)
  })
})

describe('lowerSketch group', () => {
  it('lowers one group of N members to N solver constraints sharing the anchor ref', () => {
    const { input, layout, constraintIds } = lowerSketch({
      id: 'S1',
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'c1', kind: 'circle' },
        { id: 'a1', kind: 'arc' },
      ],
      initial: { l1: [0, 0, 4, 0], c1: [6, 0, 1], a1: [0, 0, 2, 0, 90] },
      constraints: [{
        id: 'g1',
        kind: 'group',
        refs: [{ entity: 'l1' }, { entity: 'c1' }, { entity: 'a1' }],
      }],
    })
    const lineIndex = layout.findIndex(l => l.id === 'l1')
    const groups = input.constraints.filter(c => c.kind === ConstraintKindCode.group)
    expect(groups).toHaveLength(3)
    for (const group of groups) {
      expect(group.refs[1]).toEqual({
        role: Role.a,
        ref: { kind: 'entity', index: lineIndex, point: Sel.start },
      })
    }
    // Each member is the target of exactly one piece, in member order.
    expect(groups.map(g => (g.refs[0].ref as { index: number }).index)).toEqual([
      lineIndex,
      layout.findIndex(l => l.id === 'c1'),
      layout.findIndex(l => l.id === 'a1'),
    ])
    // Every piece maps back to the one authored id, so its verdict names it.
    expect(constraintIds.filter(id => id === 'g1')).toHaveLength(3)
  })

  it('anchors a circle/arc/ellipse group at the centre and a point group at xy', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [
        { id: 'c1', kind: 'circle' },
        { id: 'a1', kind: 'arc' },
        { id: 'e1', kind: 'ellipse' },
        { id: 'p1', kind: 'point' },
      ],
      initial: {
        c1: [1, 1, 2], a1: [3, 3, 1, 0, 90], e1: [5, 5, 2, 1, 0], p1: [7, 7],
      },
      constraints: [
        { id: 'gc', kind: 'group', refs: [{ entity: 'c1' }] },
        { id: 'ga', kind: 'group', refs: [{ entity: 'a1' }] },
        { id: 'ge', kind: 'group', refs: [{ entity: 'e1' }] },
        { id: 'gp', kind: 'group', refs: [{ entity: 'p1' }] },
      ],
    })
    const index = (id: string) => layout.findIndex(l => l.id === id)
    const groups = input.constraints.filter(c => c.kind === ConstraintKindCode.group)
    expect(groups.map(g => (g.refs[1].ref as { point: number }).point))
      .toEqual([Sel.center, Sel.center, Sel.center, Sel.xy])
    // Each one-member group anchors on itself.
    expect(groups.map(g => (g.refs[1].ref as { index: number }).index))
      .toEqual([index('c1'), index('a1'), index('e1'), index('p1')])
  })

  it('lowers a point member with its own selector and anchors on it', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'sp', kind: 'spline' },
      ],
      initial: { l1: [0, 3, 4, 3], sp: [0, 0, 1, 2, 3, 4, 5, 6] },
      constraints: [{
        id: 'g1', kind: 'group',
        refs: [{ entity: 'sp', point: 'c1' }, { entity: 'l1' }],
      }],
    })
    const spIndex = layout.findIndex(l => l.id === 'sp')
    const lineIndex = layout.findIndex(l => l.id === 'l1')
    const groups = input.constraints.filter(c => c.kind === ConstraintKindCode.group)
    expect(groups).toHaveLength(2)
    // The first member is a point anchor: the shared translation is that
    // point's motion, and the whole line holds against it.
    expect(groups[0].refs[0].ref).toEqual({ kind: 'entity', index: spIndex, point: Sel.c1 })
    expect(groups[0].refs[1].ref).toEqual({ kind: 'entity', index: spIndex, point: Sel.c1 })
    expect(groups[1].refs[0].ref).toEqual({ kind: 'entity', index: lineIndex, point: Sel.absent })
    expect(groups[1].refs[1].ref).toEqual({ kind: 'entity', index: spIndex, point: Sel.c1 })
  })

  it('lowers a whole-entity anchor beside a point member at its first point', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [
        { id: 'c1', kind: 'circle' },
        { id: 'sp', kind: 'spline' },
      ],
      initial: { c1: [5, 5, 1], sp: [0, 0, 1, 2, 3, 4, 5, 6] },
      constraints: [{
        id: 'g1', kind: 'group',
        refs: [{ entity: 'c1' }, { entity: 'sp', point: 'c2' }],
      }],
    })
    const spIndex = layout.findIndex(l => l.id === 'sp')
    const groups = input.constraints.filter(c => c.kind === ConstraintKindCode.group)
    expect(groups[0].refs[1].ref).toEqual({
      kind: 'entity', index: layout.findIndex(l => l.id === 'c1'), point: Sel.center,
    })
    expect(groups[1].refs[0].ref).toEqual({ kind: 'entity', index: spIndex, point: Sel.c2 })
    expect(groups[1].refs[1].ref).toEqual({
      kind: 'entity', index: layout.findIndex(l => l.id === 'c1'), point: Sel.center,
    })
  })

  it('fails loud on a member that is not a local entity ref', () => {
    expect(() => lowerSketch({
      id: 'S1',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 1, 0] },
      constraints: [{ id: 'g1', kind: 'group', refs: [{ entity: 'gone' }] }],
    })).toThrow("group 'g1' names unknown entity 'gone'")
  })

  // ─── The rotation carrier ───

  const carrierOf = (c: { refs: Array<{ role: number; ref: unknown }> }) =>
    c.refs.find(r => r.role === Role.b || r.role === Role.arc)?.ref

  it('names the farthest candidate as the carrier on every row of the group', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'c1', kind: 'circle' },
      ],
      initial: { l1: [0, 0, 4, 0], c1: [30, 0, 2] },
      constraints: [{
        id: 'g1', kind: 'group', refs: [{ entity: 'l1' }, { entity: 'c1' }],
      }],
    })
    const groups = input.constraints.filter(c => c.kind === ConstraintKindCode.group)
    expect(groups).toHaveLength(2)
    // The circle centre is 30 from the anchor, the line end only 4: the far
    // point conditions the turn best.
    const want = { kind: 'entity', index: layout.findIndex(l => l.id === 'c1'), point: Sel.center }
    for (const group of groups) expect(carrierOf(group)).toEqual(want)
  })

  it('breaks a carrier tie by member order and then selector order', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [
        { id: 'a', kind: 'line' },
        { id: 'b', kind: 'line' },
      ],
      initial: { a: [0, 0, 5, 0], b: [0, 0, -5, 0] },
      constraints: [{ id: 'g1', kind: 'group', refs: [{ entity: 'a' }, { entity: 'b' }] }],
    })
    const groups = input.constraints.filter(c => c.kind === ConstraintKindCode.group)
    // Both line ends sit 5 from the anchor; the first member's end wins.
    for (const group of groups) {
      expect(carrierOf(group)).toEqual({
        kind: 'entity', index: layout.findIndex(l => l.id === 'a'), point: Sel.end,
      })
    }
  })

  it('does not choose a derived point of a whole member as the carrier', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [
        { id: 'p', kind: 'point' },
        { id: 'a', kind: 'arc' },
        { id: 'l', kind: 'line' },
      ],
      // The arc's drawn start is 10 from the anchor while its centre sits on
      // it. A derived point has no param pair of its own, so the farthest
      // candidate that can carry the row replacement is the line's end.
      initial: { p: [0, 0], a: [0, 0, 10, 0, 90], l: [-5, 0, -5.5, 0] },
      constraints: [{
        id: 'g1', kind: 'group', refs: [{ entity: 'p' }, { entity: 'a' }, { entity: 'l' }],
      }],
    })
    const groups = input.constraints.filter(c => c.kind === ConstraintKindCode.group)
    expect(groups).toHaveLength(3)
    for (const group of groups) {
      expect(carrierOf(group)).toEqual({
        kind: 'entity', index: layout.findIndex(l => l.id === 'l'), point: Sel.end,
      })
    }
  })

  it('falls back to an arc angle when every candidate sits on the anchor', () => {
    const { input, layout } = lowerSketch({
      id: 'S1',
      entities: [
        { id: 'a', kind: 'arc' },
        { id: 'b', kind: 'arc' },
      ],
      initial: { a: [0, 0, 3, 0, 90], b: [0, 0, 2, 10, 80] },
      constraints: [{ id: 'g1', kind: 'group', refs: [{ entity: 'a' }, { entity: 'b' }] }],
    })
    const groups = input.constraints.filter(c => c.kind === ConstraintKindCode.group)
    expect(groups).toHaveLength(2)
    const arcIndex = layout.findIndex(l => l.id === 'a')
    for (const group of groups) {
      // Concentric arcs: the first whole member's start angle carries the turn.
      expect(carrierOf(group)).toEqual({ kind: 'entity', index: arcIndex, point: Sel.absent })
    }
  })

  it('lowers a lone circle with no carrier and keeps its old rows', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'c1', kind: 'circle' }],
      initial: { c1: [4, 3, 2] },
      constraints: [{ id: 'g1', kind: 'group', refs: [{ entity: 'c1' }] }],
    })
    const groups = input.constraints.filter(c => c.kind === ConstraintKindCode.group)
    expect(groups).toHaveLength(1)
    expect(carrierOf(groups[0])).toBeUndefined()
  })
})
