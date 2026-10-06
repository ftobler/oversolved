import { describe, it, expect } from 'vitest'
import { lowerSketch, pinnedMaskFor, type EntityLayout } from '../lowerSketch'
import { Kind, Role, Sel } from '../codec'

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
    { id: 'a', kind: 'line', offset: 0, size: 4 },
    { id: 'b', kind: 'line', offset: 4, size: 4 },
    { id: 'c', kind: 'circle', offset: 8, size: 3 },
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
