// The clipboard's pure format and carry rule. A copy is self-contained text:
// readable JSON, sketch-local 2D, and only the constraints that live entirely
// inside the copied set. The shared carry rule is pinned row by row in
// sketchCarry.test.ts; here the builder's user-visible result is.

import { describe, it, expect } from 'vitest'
import type { SketchFeature } from '@/types/cad'
import {
  buildSketchClip, parseClip, serializeClip, validateClip,
  NOT_OURS, NO_GEOMETRY, type SketchEntitiesClip,
} from '@/utils/clipboard/sketchClipboard'
import { makeSketch } from '@/utils/core/testFixture'

const RECT: SketchFeature = makeSketch('sk1', {
  entities: ['b', 'r', 't', 'l'].map(id => ({ id, kind: 'line' })),
  initial: { b: [0, 0, 10, 0], r: [10, 0, 10, 6], t: [10, 6, 0, 6], l: [0, 6, 0, 0] },
  constraints: [
    { id: 'k1', kind: 'coincident', a: '$bend', b: '$rstart' },
    { id: 'k2', kind: 'coincident', a: '$rend', b: '$tstart' },
    { id: 'k3', kind: 'coincident', a: '$tend', b: '$lstart' },
    { id: 'k4', kind: 'coincident', a: '$lend', b: '$bstart' },
    { id: 'h', kind: 'horizontal', target: '$b' },
    { id: 'v', kind: 'vertical', target: '$r' },
    { id: 'h2', kind: 'horizontal', target: '$t' },
    { id: 'v2', kind: 'vertical', target: '$l' },
    { id: 'w', kind: 'length', target: '$b', value: 10, pos: [0, -2] },
    { id: 'ht', kind: 'length', target: '$r', value: 6 },
  ],
}) as SketchFeature

function clipOf(sketch: SketchFeature, ids: string[], solved?: Record<string, import('@/types/cad').Entity>): SketchEntitiesClip {
  const built = buildSketchClip(sketch, ids, solved === undefined ? {} : { solved })
  if ('reason' in built) throw new Error(built.reason)
  return built.clip
}

function validClip(): SketchEntitiesClip {
  return {
    oversolved: 1,
    kind: 'sketch-entities',
    entities: [{ id: 'a', kind: 'line' }],
    initial: { a: [0, 0, 5, 0] },
    constraints: [],
    length_unit: 'mm',
  }
}

describe('buildSketchClip', () => {
  it('carries a rectangle and all of its internal constraints', () => {
    const clip = clipOf(RECT, ['b', 'r', 't', 'l'])
    expect(clip.entities.map(e => e.id)).toEqual(['b', 'r', 't', 'l'])
    expect(clip.constraints.map(c => c.id).sort()).toEqual(['h', 'h2', 'ht', 'k1', 'k2', 'k3', 'k4', 'v', 'v2', 'w'])
    expect(clip.constraints.find(c => c.id === 'w')).toMatchObject({ kind: 'length', value: 10, pos: [0, -2] })
    expect(clip.initial.b).toEqual([0, 0, 10, 0])
    expect(clip.length_unit).toBe('mm')
  })

  it('breaks origin, fixed, outside and projected anchors and counts them', () => {
    const withOutside = makeSketch('sk1', {
      entities: [
        { id: 'b', kind: 'line' }, { id: 'r', kind: 'line' },
        { id: 't', kind: 'line' }, { id: 'l', kind: 'line' },
        { id: 'far', kind: 'line' }, { id: 'proj', kind: 'line' },
      ],
      initial: {
        b: [0, 0, 10, 0], r: [10, 0, 10, 6], t: [10, 6, 0, 6], l: [0, 6, 0, 0],
        far: [30, 30, 40, 30], proj: [0, 9, 10, 9],
      },
      constraints: [
        ...(RECT.constraints ?? []),
        { id: 'origin', kind: 'coincident', a: '$bstart', b: '@builtin_origin' },
        { id: 'fx1', kind: 'fixed', target: '$b' },
        { id: 'fx2', kind: 'fixed', target: '$lstart', x: 0 },
        { id: 'dist', kind: 'point_distance', a: '$bstart', b: '$farstart', value: 5 },
        { id: 'proj_c', kind: 'projection', target: '$proj', source: '?@body_ex1:edge:1' },
      ],
    }) as SketchFeature
    const built = buildSketchClip(withOutside, ['b', 'r', 't', 'l', 'proj'])
    if ('reason' in built) throw new Error(built.reason)
    expect(built.broken).toEqual({ fixed: 2, outside: 3 })
    expect(built.clip.entities.map(e => e.id)).toEqual(['b', 'r', 't', 'l', 'proj'])
    expect(built.clip.constraints.map(c => c.id).sort()).toEqual(['h', 'h2', 'ht', 'k1', 'k2', 'k3', 'k4', 'v', 'v2', 'w'])
    expect(built.clip.entities.find(e => e.id === 'proj')!.kind).toBe('line')
  })

  it('reads a projected entity from the solved sketch, not its stale initial', () => {
    const projected = makeSketch('sk1', {
      entities: [{ id: 'proj', kind: 'line' }],
      initial: { proj: [0, 0, 0, 0] },
      constraints: [{ id: 'proj_c', kind: 'projection', target: '$proj', source: '?@body_ex1:edge:1' }],
    }) as SketchFeature
    const clip = clipOf(projected, ['proj'], { proj: { start: [1, 2], end: [8, 9] } })
    expect(clip.initial.proj).toEqual([1, 2, 8, 9])
    expect(clip.constraints).toEqual([])
  })

  it('carries a group only when every member is selected', () => {
    const grouped = makeSketch('sk1', {
      entities: [{ id: 'a', kind: 'line' }, { id: 'b', kind: 'line' }],
      initial: { a: [0, 0, 1, 0], b: [0, 1, 1, 1] },
      constraints: [{ id: 'g', kind: 'group', refs: ['$a', '$b'] }],
    }) as SketchFeature
    expect(clipOf(grouped, ['a', 'b']).constraints).toHaveLength(1)
    const built = buildSketchClip(grouped, ['a'])
    if ('reason' in built) throw new Error(built.reason)
    expect(built.clip.constraints).toEqual([])
    expect(built.broken.outside).toBe(1)
  })
})

describe('serializeClip and parseClip', () => {
  it('round-trips a clip through readable JSON', () => {
    const clip = clipOf(RECT, ['b', 'r', 't', 'l'])
    const text = serializeClip(clip)
    expect(text).toContain('"oversolved": 1')
    expect(text).toContain('\n  "kind": "sketch-entities"')
    expect(parseClip(text)).toEqual(clip)
  })

  it('refuses text that is not our geometry', () => {
    for (const text of ['hello', '{}', '[]', 'null']) {
      expect(parseClip(text)).toEqual({ reason: NOT_OURS })
    }
  })

  it('names a newer format', () => {
    expect(parseClip(JSON.stringify({ ...validClip(), oversolved: 2 }))).toEqual({
      reason: 'The clipboard holds geometry from a newer Oversolved (format 2); this version reads format 1.',
    })
  })

  it('refuses another kind', () => {
    expect(parseClip(JSON.stringify({ ...validClip(), kind: 'feature' }))).toEqual({
      reason: 'The clipboard holds feature, which cannot be pasted into a sketch.',
    })
  })

  it('refuses a parameter block of the wrong count', () => {
    const clip = validClip()
    clip.initial.a = [0, 0, 5]
    expect(parseClip(JSON.stringify(clip))).toEqual({
      reason: 'Entity a in the clipboard is not valid: a line needs 4 parameters, got 3.',
    })
  })

  it('refuses a non-finite parameter', () => {
    const clip = validClip()
    clip.initial.a = [0, 0, 5, null as unknown as number]
    expect(parseClip(JSON.stringify(clip))).toEqual({
      reason: 'Entity a in the clipboard is not valid: its parameters must be finite numbers.',
    })
  })

  it('refuses a constraint naming an id outside the clip', () => {
    const clip = validClip()
    clip.constraints = [{ id: 'c1', kind: 'horizontal', target: '$missing' }]
    expect(parseClip(JSON.stringify(clip))).toEqual({
      reason: 'Constraint c1 in the clipboard names $missing, which is not in the copied geometry.',
    })
  })

  it('refuses an empty clip', () => {
    const clip = validClip()
    clip.entities = []
    clip.initial = {}
    expect(parseClip(JSON.stringify(clip))).toEqual({ reason: NO_GEOMETRY })
  })

  it('refuses a fixed row in a supposedly free copy', () => {
    const clip = validClip()
    clip.constraints = [{ id: 'fx', kind: 'fixed', target: '$a' }]
    const out = parseClip(JSON.stringify(clip))
    expect('reason' in out && out.reason).toContain('fixed cannot be pasted into a free copy')
  })

  it('validates the clip envelope a mutation carries', () => {
    expect(validateClip(validClip())).toEqual(validClip())
    expect(validateClip(null)).toEqual({ reason: NOT_OURS })
  })
})
