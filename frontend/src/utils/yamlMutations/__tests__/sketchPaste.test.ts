// The paste_sketch_entities applier: one clip becomes one set of authored rows
// with fresh ids, the carried constraints rewritten onto them, and the numbers
// converted between document units. A refusal writes nothing. The session
// history half proves one paste is one undo entry.

import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchEntitiesClip, SketchFeature } from '@/types/cad'
import { applyPasteSketchEntities } from '@/utils/yamlMutations/sketchPaste'
import { MutationRefusal } from '@/utils/yamlMutations/helpers'
import { buildSketchClip } from '@/utils/clipboard/sketchClipboard'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { featureById } from '@/testing/featureAccess'
import { createHeadlessPart } from '@/drive/headlessPart'
import { docHashOf } from '@/drive/docHash'
import { mutationValueViolation, type ValueContext } from '@/drive/mutationValues'

const RECT = makeSketch('sk1', {
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

const rectClip = (): SketchEntitiesClip => {
  const built = buildSketchClip(RECT, ['b', 'r', 't', 'l'])
  if ('reason' in built) throw new Error(built.reason)
  return built.clip
}

const emptySketch = (id = 'sk2', plane = '@builtin_plane_top'): SketchFeature =>
  makeSketch(id, { plane, entities: [], initial: {}, constraints: [] }) as SketchFeature

const sketchOf = (doc: PartDoc, id: string): SketchFeature => featureById(doc, id, 'sketch')

const copy = (doc: PartDoc): PartDoc => JSON.parse(JSON.stringify(doc)) as PartDoc

describe('paste_sketch_entities document write', () => {
  it('carries the driven flag through a copy/paste', () => {
    const source = {
      ...RECT,
      constraints: [
        ...(RECT.constraints ?? []),
        {
          id: 'diag', kind: 'point_distance', a: '$bstart', b: '$rend',
          value: Math.hypot(10, 6), driven: true as const,
        },
      ],
    } as SketchFeature
    const built = buildSketchClip(source, ['b', 'r', 't', 'l'])
    if ('reason' in built) throw new Error(built.reason)
    const d = makeDoc(emptySketch())
    applyPasteSketchEntities(d, { featureId: 'sk2', clip: built.clip, offset: [0, 0] })
    const pasted = sketchOf(d, 'sk2').constraints?.find(c => c.kind === 'point_distance')
    expect(pasted?.driven).toBe(true)
  })

  it('adds the rectangle with fresh ids, moved by the offset, constraints rewritten', () => {
    const doc = makeDoc(emptySketch())
    applyPasteSketchEntities(doc, { featureId: 'sk2', clip: rectClip(), offset: [10, 5] })
    const sketch = sketchOf(doc, 'sk2')
    const entities = sketch.entities ?? []
    expect(entities).toHaveLength(4)
    const ids = entities.map(e => e.id)
    ids.forEach(id => expect(['b', 'r', 't', 'l']).not.toContain(id))
    expect(sketch.initial?.[ids[0]]).toEqual([10, 5, 20, 5])
    expect(sketch.initial?.[ids[1]]).toEqual([20, 5, 20, 11])

    const constraints = sketch.constraints ?? []
    expect(constraints).toHaveLength(10)
    expect(new Set(constraints.map(c => c.id)).size).toBe(10)
    expect(constraints.some(c => c.id === 'k1')).toBe(false)
    // The joint keeps its vertex suffix and its `$` prefix on the pasted line.
    const joint = constraints.find(c => c.kind === 'coincident' && c.a === `$${ids[0]}end`)
    expect(joint).toMatchObject({ b: `$${ids[1]}start` })
    const width = constraints.find(c => c.kind === 'length' && c.target === `$${ids[0]}`)!
    expect(width.value).toBe(10)
    // pos is relative to the dimension's anchor, so the paste offset leaves it
    // alone; only a unit conversion scales it.
    expect(width.pos).toEqual([0, -2])
  })

  it('pastes into the source sketch without colliding or touching the source', () => {
    const doc = makeDoc(RECT)
    const before = copy(doc)
    applyPasteSketchEntities(doc, { featureId: 'sk1', clip: rectClip(), offset: [0, 20] })
    const sketch = sketchOf(doc, 'sk1')
    expect(sketch.entities).toHaveLength(8)
    expect(new Set((sketch.entities ?? []).map(e => e.id)).size).toBe(8)
    expect(sketch.constraints).toHaveLength(20)
    // The source rows are byte-identical.
    expect((sketch.entities ?? []).slice(0, 4)).toEqual((before.features![0] as SketchFeature).entities)
    expect(sketch.initial?.b).toEqual([0, 0, 10, 0])
    expect(sketch.constraints?.find(c => c.id === 'k1')).toEqual(
      { id: 'k1', kind: 'coincident', a: '$bend', b: '$rstart' },
    )
  })

  it('allows another plane and keeps the same 2D shape apart from the offset', () => {
    const doc = makeDoc(emptySketch('sk2', '@builtin_plane_right'))
    applyPasteSketchEntities(doc, { featureId: 'sk2', clip: rectClip(), offset: [2, 3] })
    const sketch = sketchOf(doc, 'sk2')
    expect(sketch.plane).toBe('@builtin_plane_right')
    const ids = (sketch.entities ?? []).map(e => e.id)
    expect(sketch.initial?.[ids[0]]).toEqual([2, 3, 12, 3])
    expect(sketch.initial?.[ids[2]]).toEqual([12, 9, 2, 9])
  })

  it('keeps construction and fit-spline handles', () => {
    const source = makeSketch('sk1', {
      entities: [
        { id: 'c1', kind: 'line', construction: true },
        { id: 'fit', kind: 'fit_spline', handles: 'both' },
      ],
      initial: { c1: [0, 0, 1, 0], fit: [0, 0, 2, 1, 3, 0, -1, -1, 4, 1] },
      constraints: [],
    }) as SketchFeature
    const built = buildSketchClip(source, ['c1', 'fit'])
    if ('reason' in built) throw new Error(built.reason)
    const doc = makeDoc(emptySketch())
    applyPasteSketchEntities(doc, { featureId: 'sk2', clip: built.clip, offset: [5, 5] })
    const sketch = sketchOf(doc, 'sk2')
    expect(sketch.entities?.[0]).toMatchObject({ kind: 'line', construction: true })
    expect(sketch.entities?.[1]).toMatchObject({ kind: 'fit_spline', handles: 'both' })
    expect(sketch.initial?.[(sketch.entities ?? [])[1].id]).toEqual([5, 5, 7, 6, 8, 5, 4, 4, 9, 6])
  })

  it('refuses an invalid clip and leaves the document unchanged', () => {
    const doc = makeDoc(emptySketch())
    const before = copy(doc)
    expect(() => applyPasteSketchEntities(doc, {
      featureId: 'sk2', clip: { oversolved: 1, kind: 'sketch-entities' } as unknown as SketchEntitiesClip,
    })).toThrow(new MutationRefusal('The clipboard does not hold Oversolved sketch geometry.'))
    expect(doc).toEqual(before)
  })

  it('refuses a paste into a missing sketch with the open-a-sketch sentence', () => {
    const doc = makeDoc(emptySketch())
    expect(() => applyPasteSketchEntities(doc, { featureId: 'nope', clip: rectClip() }))
      .toThrow(new MutationRefusal('Open a sketch to paste sketch geometry.'))
  })

  it('refuses a non-finite offset', () => {
    const doc = makeDoc(emptySketch())
    expect(() => applyPasteSketchEntities(doc, { featureId: 'sk2', clip: rectClip(), offset: [0, Infinity] }))
      .toThrow(new MutationRefusal('The paste offset must be a finite [x, y] point.'))
  })

  it('refuses an over-cap paste and leaves the document unchanged', () => {
    const full = makeSketch('sk2', {
      entities: Array.from({ length: 4096 }, (_, index) => ({ id: `e${index}`, kind: 'line' })),
      initial: {},
      constraints: [],
    }) as SketchFeature
    const doc = makeDoc(full)
    const before = copy(doc)
    expect(() => applyPasteSketchEntities(doc, { featureId: 'sk2', clip: rectClip(), offset: [0, 0] }))
      .toThrow(/the sketch holds at most 4096/)
    expect(doc).toEqual(before)
  })

  it('converts a millimetre clip into an inch document at the same physical size', () => {
    const doc: PartDoc = { ...makeDoc(emptySketch()), length_unit: 'inch' }
    const clip = rectClip()
    applyPasteSketchEntities(doc, { featureId: 'sk2', clip, offset: [0, 0] })
    const sketch = sketchOf(doc, 'sk2')
    const ids = (sketch.entities ?? []).map(e => e.id)
    // 10 mm is 10 / 25.4 in.
    expect(sketch.initial?.[ids[0]][2]).toBeCloseTo(10 / 25.4, 6)
    expect(sketch.initial?.[ids[0]][3]).toBeCloseTo(0, 6)
    // The width dimension is a length too; the angle-like slots are not.
    const width = (sketch.constraints ?? []).find(c => c.kind === 'length' && c.target === `$${ids[0]}`)!
    expect(width.value).toBeCloseTo(10 / 25.4, 6)
    expect(width.pos?.[1]).toBeCloseTo(-2 / 25.4, 6)
  })
})

describe('paste_sketch_entities drive boundary', () => {
  const ctx = (doc: PartDoc): ValueContext => ({ doc, fileIds: null, fieldSchema: () => null })

  it('refuses a malformed clip with the sentence the toast shows', () => {
    const violation = mutationValueViolation('paste_sketch_entities', {
      type: 'paste_sketch_entities', featureId: 'sk2',
      clip: { oversolved: 1, kind: 'sketch-entities' },
    }, ctx(makeDoc(emptySketch())))
    expect(violation?.code).toBe('invalid-mutation')
    expect(violation?.message).toBe('The clipboard does not hold Oversolved sketch geometry.')
  })

  it('refuses an offset that is not a finite point', () => {
    const violation = mutationValueViolation('paste_sketch_entities', {
      type: 'paste_sketch_entities', featureId: 'sk2', clip: rectClip(), offset: [0],
    }, ctx(makeDoc(emptySketch())))
    expect(violation?.message).toBe('offset must be a finite [x, y] point, got [0]')
  })

  it('a headless step pastes the clip; an invalid clip is a refused step', async () => {
    const part = createHeadlessPart({ doc: makeDoc(emptySketch()) })
    const ok = await part.run([
      { mutation: { type: 'paste_sketch_entities', featureId: 'sk2', clip: rectClip(), offset: [1, 2] } },
    ])
    expect(ok.ok).toBe(true)
    expect((sketchOf(part.getDoc()!, 'sk2').entities ?? [])).toHaveLength(4)

    const badPart = createHeadlessPart({ doc: makeDoc(emptySketch()) })
    const bad = await badPart.run([
      { mutation: { type: 'paste_sketch_entities', featureId: 'sk2', clip: { oversolved: 1 } as unknown as SketchEntitiesClip } },
    ])
    expect(bad.ok).toBe(false)
    expect(bad.steps[0].error?.message).toBe('The clipboard does not hold Oversolved sketch geometry.')
  })
})

describe('paste history', () => {
  it('one paste is one undo entry; undo removes it and redo restores the same ids', async () => {
    const part = createHeadlessPart({ doc: makeDoc() })
    const setup = await part.run([
      { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' } },
    ])
    expect(setup.ok).toBe(true)
    const before = docHashOf(part.getDoc()!)
    const clip = rectClip()

    const pasted = await part.run([
      { mutation: { type: 'paste_sketch_entities', featureId: 'sk2', clip, offset: [10, 5] } },
    ])
    expect(pasted.ok).toBe(true)
    const forward = part.getDoc()!
    const ids = (sketchOf(forward, 'sk2').entities ?? []).map(e => e.id)
    expect(ids).toHaveLength(4)
    expect(sketchOf(forward, 'sk2').constraints).toHaveLength(10)
    expect(docHashOf(forward)).not.toBe(before)

    expect((await part.run([{ command: 'undo' }])).ok).toBe(true)
    expect(docHashOf(part.getDoc()!)).toBe(before)
    expect(sketchOf(part.getDoc()!, 'sk2').entities ?? []).toEqual([])

    expect((await part.run([{ command: 'redo' }])).ok).toBe(true)
    expect((sketchOf(part.getDoc()!, 'sk2').entities ?? []).map(e => e.id)).toEqual(ids)
    expect(docHashOf(part.getDoc()!)).toBe(docHashOf(forward))
  })
})
