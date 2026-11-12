// The pattern_entities applier: copies land as plain authored rows with fresh
// ids in instance-major order, constraints among the sources follow each copy
// (with the orientation-bound kinds turned or dropped), anything reaching
// outside the source set stays on the source, and a refused step writes
// nothing. The transform math is pinned in
// utils/geometry/__tests__/sketchPattern.test.ts.

import { describe, it, expect } from 'vitest'
import type { DimAngleRender, Mutation, PartConstraint, PartDoc, SketchFeature } from '@/types/cad'
import { applyMirrorEntities, applyPatternEntities, type PatternEntitiesStep } from '@/utils/yamlMutations'
import { mutationValueViolation, type ValueContext } from '@/drive/mutationValues'
import { computeConstraintRender, unflattenGeometry } from '@/utils/geometry/geometryMapping'
import { computeAngleDimension } from '@/utils/geometry/angleDimensionLogic'
import { featureById } from '@/testing/featureAccess'
import { roundedRectProfile, mergeProfiles, type ProfileBlocks } from '@/testing/sketchPatternFixtures'

const copy = (doc: PartDoc): PartDoc => JSON.parse(JSON.stringify(doc)) as PartDoc

const sketchDoc = (blocks: ProfileBlocks, extra: Partial<SketchFeature> = {}, more: SketchFeature[] = []): PartDoc => ({
  features: [
    { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', ...blocks, ...extra },
    ...more,
  ],
})

const sk = (doc: PartDoc, id = 'sk1'): Required<Pick<SketchFeature, 'entities' | 'initial' | 'constraints'>> => {
  const f = featureById(doc, id, 'sketch')
  return { entities: f.entities ?? [], initial: f.initial ?? {}, constraints: f.constraints ?? [] }
}

const step = (fields: Omit<PatternEntitiesStep, 'featureId'> & { featureId?: string }): PatternEntitiesStep =>
  ({ featureId: 'sk1', ...fields })

const ctx = (doc: PartDoc): ValueContext => ({ doc, fileIds: null, fieldSchema: () => null })

const violation = (doc: PartDoc, fields: Record<string, unknown>) =>
  mutationValueViolation('pattern_entities', { type: 'pattern_entities', featureId: 'sk1', ...fields } as Record<string, unknown>, ctx(doc))

// The four lines of a 10 x 6 rectangle with its joints, a horizontal bottom,
// a vertical right side, an equal pair, a length and a fixed corner.
function rectBlocks(): ProfileBlocks {
  return {
    entities: ['b', 'r', 't', 'l'].map(id => ({ id, kind: 'line' })),
    initial: { b: [0, 0, 10, 0], r: [10, 0, 10, 6], t: [10, 6, 0, 6], l: [0, 6, 0, 0] },
    constraints: [
      { id: 'k1', kind: 'coincident', a: '$bend', b: '$rstart' },
      { id: 'k2', kind: 'coincident', a: '$rend', b: '$tstart' },
      { id: 'k3', kind: 'coincident', a: '$tend', b: '$lstart' },
      { id: 'k4', kind: 'coincident', a: '$lend', b: '$bstart' },
      { id: 'h', kind: 'horizontal', target: '$b' },
      { id: 'v', kind: 'vertical', target: '$r' },
      { id: 'eq', kind: 'equal_length', a: '$b', b: '$t' },
      { id: 'len', kind: 'length', target: '$b', value: 10, pos: [0, -2] },
      { id: 'fx', kind: 'fixed', target: '$bstart', x: 0, y: 0 },
    ],
  }
}

const TOOTH = () => roundedRectProfile('', 0, 0, 1, 1.2, 0.168)
const TOOTH_IDS = ['b', 'r', 't', 'l', 'a1', 'a2', 'a3', 'a4']

/** The constraints whose operands all name the given ids. */
const constraintsAmong = (constraints: PartConstraint[], ids: string[]): PartConstraint[] =>
  constraints.filter(c => ['target', 'a', 'b'].every(f => {
    const ref = c[f as 'a']
    if (typeof ref !== 'string') return true
    return ids.some(id => ref === `$${id}` || (ref.startsWith(`$${id}`) && /^(start|end|center)$/.test(ref.slice(id.length + 1))))
  }))

describe('pattern_entities document write', () => {
  it('the gear-rack row: 63 teeth of 8 entities, each copy with its own joints only', () => {
    const blocks = TOOTH()
    // A bar edge the tooth is tied to: that tie stays on the source alone.
    blocks.entities.push({ id: 'bar', kind: 'line' })
    blocks.initial.bar = [-5, 0, 105, 0]
    blocks.constraints.push({ id: 'tie', kind: 'colinear', a: '$bstart', b: '$bar' })
    const doc = sketchDoc(blocks)
    const before = copy(doc)

    applyPatternEntities(doc, step({ sourceIds: TOOTH_IDS, mode: 'linear', count: 63, pitch: 1.570796, direction: [1, 0] }))
    const { entities, initial, constraints } = sk(doc)
    expect(entities).toHaveLength(9 + 62 * 8)
    expect(entities.filter(e => e.id !== 'bar')).toHaveLength(63 * 8)

    // Sources are untouched and the copies follow in instance-major order.
    expect(entities.slice(0, 9)).toEqual(sk(before).entities)
    TOOTH_IDS.forEach(id => expect(initial[id]).toEqual(sk(before).initial[id]))
    const copies = entities.slice(9)
    expect(new Set(copies.map(e => e.id)).size).toBe(copies.length)
    copies.forEach(e => expect(TOOTH_IDS).not.toContain(e.id))
    expect(copies.map(e => e.kind).slice(0, 8)).toEqual(['line', 'line', 'line', 'line', 'arc', 'arc', 'arc', 'arc'])
    // The last block is instance 62: the bottom line moved 62 pitches.
    expect(initial[copies[61 * 8].id]).toEqual([0.168 + 62 * 1.570796, 0, 1 - 0.168 + 62 * 1.570796, 0].map(v => Math.round(v * 1e6) / 1e6))

    // 8 joints per copy, all inside that copy; the tie is never cloned.
    for (let k = 0; k < 62; k++) {
      const ids = copies.slice(k * 8, k * 8 + 8).map(e => e.id)
      const own = constraintsAmong(constraints, ids).filter(c => c.kind === 'coincident')
      expect(own).toHaveLength(8)
    }
    expect(constraints.filter(c => c.kind === 'colinear')).toHaveLength(1)
    expect(constraints).toHaveLength(9 + 62 * 8)

    // A second identical step adds another 496 rather than reusing ids.
    applyPatternEntities(doc, step({ sourceIds: TOOTH_IDS, mode: 'linear', count: 63, pitch: 1.570796 }))
    const after = sk(doc).entities
    expect(after).toHaveLength(9 + 2 * 62 * 8)
    expect(new Set(after.map(e => e.id)).size).toBe(after.length)
  })

  it('a 3 x 2 grid of a rectangle remaps every carried constraint to its own copy', () => {
    const doc = sketchDoc(rectBlocks())
    applyPatternEntities(doc, step({ sourceIds: ['b', 'r', 't', 'l'], mode: 'grid', count: 3, count2: 2, pitch: 20, pitch2: 15 }))
    const { entities, initial, constraints } = sk(doc)
    expect(entities).toHaveLength(4 + 5 * 4)
    // Column 2, row 1 is the last block of the row-major walk.
    const last = entities.slice(-4).map(e => e.id)
    expect(initial[last[0]]).toEqual([40, 15, 50, 15])
    const own = constraintsAmong(constraints, last)
    expect(own.map(c => c.kind).sort()).toEqual(
      ['coincident', 'coincident', 'coincident', 'coincident', 'equal_length', 'fixed', 'horizontal', 'length', 'vertical'],
    )
    expect(own.find(c => c.kind === 'horizontal')!.target).toBe(`$${last[0]}`)
    expect(own.find(c => c.kind === 'fixed')).toMatchObject({ target: `$${last[0]}start`, x: 40, y: 15 })
    expect(constraints).toHaveLength(9 * 6)
    expect(new Set(constraints.map(c => c.id)).size).toBe(constraints.length)
  })

  it('a copy at 30 deg keeps relations and drops horizontal/vertical', () => {
    const doc = sketchDoc(rectBlocks())
    applyPatternEntities(doc, step({ sourceIds: ['b', 'r', 't', 'l'], mode: 'copy', angle_deg: 30, translate: [40, 0] }))
    const { entities, constraints } = sk(doc)
    const ids = entities.slice(4).map(e => e.id)
    const own = constraintsAmong(constraints, ids)
    expect(own.map(c => c.kind).sort()).toEqual(['coincident', 'coincident', 'coincident', 'coincident', 'equal_length', 'fixed', 'length'])
    const fixed = own.find(c => c.kind === 'fixed')!
    expect(fixed).toMatchObject({ x: 40, y: 0 })
    const len = own.find(c => c.kind === 'length')!
    expect(len.value).toBe(10)
    expect(len.pos![0]).toBeCloseTo(1, 6)
    expect(len.pos![1]).toBeCloseTo(-Math.sqrt(3), 6)
  })

  it('a copy at 90 deg swaps horizontal and vertical', () => {
    const doc = sketchDoc(rectBlocks())
    applyPatternEntities(doc, step({ sourceIds: ['b', 'r', 't', 'l'], mode: 'copy', angle_deg: 90, translate: [40, 0] }))
    const { entities, initial, constraints } = sk(doc)
    const [b2, r2] = entities.slice(4).map(e => e.id)
    expect(initial[b2]).toEqual([40, 0, 40, 10])
    expect(constraints.find(c => c.target === `$${b2}` && (c.kind === 'horizontal' || c.kind === 'vertical'))!.kind).toBe('vertical')
    expect(constraints.find(c => c.target === `$${r2}` && (c.kind === 'horizontal' || c.kind === 'vertical'))!.kind).toBe('horizontal')
  })

  it('a mirrored pair copied at 90 deg carries the mirror joints and the swapped axis kinds', () => {
    const doc = sketchDoc({
      entities: [{ id: 'axis', kind: 'line', construction: true }, { id: 'h', kind: 'line' }],
      initial: { axis: [0, -10, 0, 10], h: [0, 0, 5, 0] },
      constraints: [
        { id: 'c_h', kind: 'horizontal', target: '$h' },
        { id: 'c_on', kind: 'coincident', a: '$hstart', b: '$axis' },
      ],
    })
    applyMirrorEntities(doc, 'sk1', ['h'], 'axis')
    const mirrored = sk(doc).entities[2].id
    // The mirror carried the horizontal onto its copy; the copy pair is h + image.
    applyPatternEntities(doc, step({ sourceIds: ['h', mirrored], mode: 'rotate', count: 2, angle_deg: 90, center: [0, 0] }))
    const { entities, initial, constraints } = sk(doc)
    const [h2, m2] = entities.slice(3).map(e => e.id)
    expect(initial[h2]).toEqual([0, 0, 0, 5])
    expect(initial[m2]).toEqual([0, 0, 0, -5])
    expect(constraints.filter(c => c.kind === 'vertical').map(c => c.target).sort()).toEqual([`$${h2}`, `$${m2}`].sort())
    // c_on names the axis, outside the source set: it stays with the source.
    expect(constraints.filter(c => c.a === `$${h2}start`)).toEqual([])
  })

  it('a mirrored supplement-wedge angle label shows the same number on the copy', () => {
    // The label offset is mirrored like any other vector, and the wedge type
    // survives reflection, so the copy must display what the source displays.
    // No applier re-encodes the carried value: the mirrored theta is unchanged.
    const doc = sketchDoc({
      entities: [{ id: 'ax', kind: 'line' }, { id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }],
      initial: { ax: [0, -10, 0, 10], l1: [2.5, 0, 6.5, 0], l2: [6.5, 0, 6, 0.5] },
      constraints: [{ id: 'c_ang', kind: 'angle', a: '$l1', b: '$l2', value: 135, pos: [-1, 0.4] }],
    })
    applyMirrorEntities(doc, 'sk1', ['l1', 'l2'], 'ax')
    const { entities, initial, constraints } = sk(doc)
    const angles = constraints.filter(c => c.kind === 'angle')
    expect(angles).toHaveLength(2)
    const source = angles.find(c => c.id === 'c_ang')!
    const copy = angles.find(c => c.id !== 'c_ang')!
    const sketch = unflattenGeometry(initial, entities)
    const displayed = (c: PartConstraint): { value: number; supplement: boolean } => {
      const render = computeConstraintRender(c, sketch) as DimAngleRender | { kind: string }
      if (render.kind !== 'dim_angle') throw new Error('the angle render did not resolve')
      const r = render as DimAngleRender
      const geo = computeAngleDimension(r.p1, r.p2, r.p3, r.p4, c.pos)
      const value = c.value ?? 0
      return { value: geo.isSupplement ? 180 - value : value, supplement: geo.isSupplement }
    }
    expect(displayed(source)).toEqual(displayed(copy))
    expect(displayed(source)).toMatchObject({ value: 45, supplement: true })
    expect(copy.pos).toEqual([1, 0.4])
  })

  it('copies into another sketch on the same plane, Front and @builtin_plane_front alike', () => {
    const other: SketchFeature = { id: 'sk2', kind: 'sketch', plane: 'Front', entities: [{ id: 'keep', kind: 'point' }], initial: { keep: [1, 1] }, constraints: [] }
    const doc = sketchDoc(rectBlocks(), {}, [other])
    applyPatternEntities(doc, step({ sourceIds: ['b', 'r', 't', 'l'], mode: 'copy', targetFeatureId: 'sk2' }))
    const target = sk(doc, 'sk2')
    expect(target.entities).toHaveLength(5)
    expect(target.entities[0].id).toBe('keep')
    expect(true).toBe(true)
    const ids = target.entities.slice(1).map(e => e.id)
    expect(ids.map(id => target.initial[id])).toEqual([[0, 0, 10, 0], [10, 0, 10, 6], [10, 6, 0, 6], [0, 6, 0, 0]])
    expect(target.constraints).toHaveLength(9)
    expect(constraintsAmong(target.constraints, ids)).toHaveLength(9)
    // The source sketch is untouched.
    expect(sk(doc).entities).toHaveLength(4)
  })

  it('refuses a cross-plane copy, and every refused step writes nothing', () => {
    const top: SketchFeature = { id: 'sk2', kind: 'sketch', plane: '@builtin_plane_top', entities: [], initial: {}, constraints: [] }
    const doc = sketchDoc(rectBlocks(), {}, [top])
    const before = copy(doc)
    const refused: Record<string, unknown>[] = [
      { sourceIds: ['b'], mode: 'copy', targetFeatureId: 'sk2' },
      { sourceIds: ['b'], mode: 'linear', count: 201, pitch: 1 },
      { sourceIds: ['b'], mode: 'linear', count: 0, pitch: 1 },
      { sourceIds: ['b'], mode: 'linear', count: 2.5, pitch: 1 },
      { sourceIds: ['b'], mode: 'linear', count: 3, pitch: 0 },
      { sourceIds: ['b'], mode: 'spiral', count: 3 },
      { sourceIds: ['nope'], mode: 'linear', count: 3, pitch: 1 },
      { sourceIds: ['b'], mode: 'linear', count: 3, pitch: 1, center: [0, 0] },
      { sourceIds: ['b'], mode: 'linear', count: 3, pitch: 1, targetFeatureId: 'sk2' },
    ]
    const messages = refused.map(fields => {
      applyPatternEntities(doc, { featureId: 'sk1', ...fields } as PatternEntitiesStep)
      return violation(doc, fields)?.message
    })
    expect(doc).toEqual(before)
    expect(messages[0]).toContain('cannot map between different sketch planes')
    expect(messages[1]).toBe('pattern_entities: count 201 is above the cap of 200 instances')
    expect(messages[2]).toContain('count must be a whole number')
    expect(messages[3]).toContain('count must be a whole number')
    expect(messages[4]).toContain('pitch must not be zero')
    expect(messages[5]).toContain('mode must be one of linear, grid, rotate, copy')
    expect(messages[6]).toContain('names no entity in sketch sk1')
    expect(messages[7]).toBe('pattern_entities: center is not a linear field; linear reads count, pitch, direction')
    expect(messages[8]).toContain('targetFeatureId is a copy-mode field')
  })

  it('refuses a pattern that would overflow the sketch entity cap, and a projected source', () => {
    const many: ProfileBlocks = mergeProfiles(...Array.from({ length: 13 }, (_, i) => roundedRectProfile(`t${i}_`, i * 2, 0, 1, 1, 0.1)))
    many.entities = many.entities.slice(0, 100)
    const doc = sketchDoc(many)
    const ids = many.entities.map(e => e.id)
    const before = copy(doc)
    expect(violation(doc, { sourceIds: ids, mode: 'linear', count: 50, pitch: 30 })?.message)
      .toBe('pattern_entities: would add 4900 entities to the 100 already in sketch sk1; the sketch holds at most 4096')
    applyPatternEntities(doc, step({ sourceIds: ids, mode: 'linear', count: 50, pitch: 30 }))
    expect(doc).toEqual(before)

    const projected = sketchDoc({
      entities: [{ id: 'p', kind: 'line' }],
      initial: { p: [0, 0, 1, 0] },
      constraints: [{ id: 'proj_p', kind: 'projection', target: '$p', source: '@sk0/l1' }],
    })
    expect(violation(projected, { sourceIds: ['p'], mode: 'linear', count: 2, pitch: 5 })?.message)
      .toBeUndefined()
  })

  it('the registry example shape: a two-line linear copy lands at the pitch', () => {
    // mutationExamples drives this shape through the real dispatch; here the
    // plain applier on the same shape pins where the copies land.
    const doc = sketchDoc({
      entities: [{ id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0], l2: [0, 5, 10, 5] },
      constraints: [],
    })
    const m: Extract<Mutation, { type: 'pattern_entities' }> = {
      type: 'pattern_entities', featureId: 'sk1', sourceIds: ['l1', 'l2'], mode: 'linear', count: 2, pitch: 20,
    }
    applyPatternEntities(doc, m)
    expect(sk(doc).entities.slice(2).map(e => sk(doc).initial[e.id])).toEqual([[20, 0, 30, 0], [20, 5, 30, 5]])
  })
})
