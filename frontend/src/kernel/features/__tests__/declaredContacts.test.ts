// The pure lowering from authored constraints to the area builder's declared
// contacts. No WASM, no OCC: the test pins the rule the builder consumes.

import { describe, it, expect } from 'vitest'
import type { EntityLayout, SketchInput } from '@/wasm-kernel/lowerSketch'
import { declaredContacts } from '../shared/declaredContacts'

function layout(entries: Array<{ id: string; kind: string; construction?: boolean }>): EntityLayout[] {
  return entries.map((e, i) => ({
    id: e.id,
    kind: e.kind,
    offset: i * 4,
    size: e.kind === 'circle' ? 3 : 4,
    flags: 0,
    construction: e.construction,
  }))
}

function sketch(
  entities: Array<{ id: string; kind: string; construction?: boolean }>,
  constraints: Array<Record<string, unknown>>,
): SketchInput {
  return {
    id: 'sk',
    entities: entities.map((e) => ({ id: e.id, kind: e.kind, construction: e.construction })),
    initial: {},
    constraints,
  }
}

const coincident = (id: string, a: unknown, b: unknown): Record<string, unknown> => ({
  id,
  kind: 'coincident',
  a,
  b,
})

describe('declaredContacts', () => {
  it('lowers a vertex-vertex coincident to a join', () => {
    const entities = [
      { id: 'l1', kind: 'line' },
      { id: 'l2', kind: 'line' },
    ]
    const contacts = declaredContacts(
      sketch(entities, [coincident('c1', { entity: 'l1', point: 'end' }, { entity: 'l2', point: 'start' })]),
      layout(entities),
      'underconstrained',
    )
    expect(contacts).toEqual([
      {
        id: 'c1',
        kind: 'join',
        a: { entity: 'l1', point: 'end' },
        b: { entity: 'l2', point: 'start' },
      },
    ])
  })

  it('accepts a fit spline end as a join endpoint', () => {
    const entities = [
      { id: 'f', kind: 'fit_spline' },
      { id: 'l', kind: 'line' },
    ]
    const contacts = declaredContacts(
      sketch(entities, [coincident('c1', { entity: 'f', point: 'end' }, { entity: 'l', point: 'start' })]),
      layout(entities),
      'fully_constrained',
    )
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({ kind: 'join', a: { entity: 'f', point: 'end' } })
  })

  it('lowers an endpoint on another curve to an on contact, either order', () => {
    const entities = [
      { id: 'l', kind: 'line' },
      { id: 'c', kind: 'circle' },
    ]
    const l = layout(entities)
    const forward = declaredContacts(
      sketch(entities, [coincident('c1', { entity: 'l', point: 'end' }, { entity: 'c' })]),
      l,
      'underconstrained',
    )
    const reverse = declaredContacts(
      sketch(entities, [coincident('c1', { entity: 'c' }, { entity: 'l', point: 'end' })]),
      l,
      'underconstrained',
    )
    expect(forward).toEqual([
      { id: 'c1', kind: 'on', a: { entity: 'l', point: 'end' }, b: { entity: 'c' } },
    ])
    expect(reverse).toEqual(forward)
  })

  it('carries the join flag on a tangent between the joined curves', () => {
    const entities = [
      { id: 'li', kind: 'line' },
      { id: 'ar', kind: 'arc' },
    ]
    const l = layout(entities)
    const joined = declaredContacts(
      sketch(entities, [
        coincident('j', { entity: 'li', point: 'end' }, { entity: 'ar', point: 'start' }),
        { id: 't', kind: 'tangent', a: { entity: 'li' }, b: { entity: 'ar' } },
      ]),
      l,
      'underconstrained',
    )
    expect(joined.find((c) => c.kind === 'tangent')).toEqual({
      id: 't',
      kind: 'tangent',
      a: { entity: 'li' },
      b: { entity: 'ar' },
      join: true,
    })

    const free = declaredContacts(
      sketch(entities, [{ id: 't', kind: 'tangent', a: { entity: 'li' }, b: { entity: 'ar' } }]),
      l,
      'underconstrained',
    )
    expect(free.find((c) => c.kind === 'tangent')).toMatchObject({ join: false })
  })

  it('contributes nothing for construction entities', () => {
    const entities = [
      { id: 'l', kind: 'line' },
      { id: 'g', kind: 'line', construction: true },
      { id: 'c', kind: 'circle', construction: true },
    ]
    const contacts = declaredContacts(
      sketch(entities, [
        coincident('c1', { entity: 'l', point: 'end' }, { entity: 'g', point: 'start' }),
        coincident('c2', { entity: 'l', point: 'start' }, { entity: 'c' }),
        { id: 't', kind: 'tangent', a: { entity: 'l' }, b: { entity: 'g' } },
      ]),
      layout(entities),
      'underconstrained',
    )
    expect(contacts).toEqual([])
  })

  it('contributes nothing for an overconstrained solve', () => {
    const entities = [
      { id: 'l1', kind: 'line' },
      { id: 'l2', kind: 'line' },
    ]
    const contacts = declaredContacts(
      sketch(entities, [coincident('c1', { entity: 'l1', point: 'end' }, { entity: 'l2', point: 'start' })]),
      layout(entities),
      'overconstrained',
    )
    expect(contacts).toEqual([])
  })

  it('ignores a non-endpoint vertex ref and a curve-to-curve coincident', () => {
    const entities = [
      { id: 'l', kind: 'line' },
      { id: 'c', kind: 'circle' },
      { id: 'e', kind: 'ellipse' },
    ]
    const contacts = declaredContacts(
      sketch(entities, [
        coincident('c1', { entity: 'c', point: 'center' }, { entity: 'l' }),
        coincident('c2', { entity: 'l', point: 'start' }, { entity: 'e' }),
        // Two bare curves are not a point contact.
        coincident('c3', { entity: 'c' }, { entity: 'e' }),
      ]),
      layout(entities),
      'underconstrained',
    )
    // c2 is a real T-junction (line start on the ellipse locus).
    expect(contacts).toEqual([
      { id: 'c2', kind: 'on', a: { entity: 'l', point: 'start' }, b: { entity: 'e' } },
    ])
  })
})
