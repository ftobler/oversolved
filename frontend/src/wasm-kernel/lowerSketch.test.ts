import { describe, it, expect } from 'vitest'
import { lowerSketch } from './lowerSketch'
import { Kind, Role, Sel } from './codec'

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
