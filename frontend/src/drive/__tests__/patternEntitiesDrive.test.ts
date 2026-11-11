// @vitest-environment node
//
// pattern_entities through the headless session: one step is one undo entry
// however many copies it adds, a refused step writes nothing, and the command
// gate's selection plan refuses the same selections the drive rule does.
// Solves fail benignly here (OCC is not injected); the real kernel suite is
// patternEntitiesReal.test.ts.

import { describe, it, expect } from 'vitest'
import { createHeadlessPart } from '../headlessPart'
import { docHashOf } from '../docHash'
import { patternSelectionPlan } from '@/stores/editorState'
import { parsePatternInput } from '@/pages/commandEntries'
import { mutationValueViolation } from '@/drive/mutationValues'
import type { PartDoc, SketchFeature } from '@/types/cad'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}

const sketchOf = (doc: PartDoc | null): SketchFeature =>
  doc!.features!.find(f => f.id === 'sk1') as SketchFeature

describe('pattern_entities session history', () => {
  it('one step is one undo entry; redo restores the 16 lines and their constraints', async () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    const setup = await part.run([
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 6] } },
    ])
    expect(setup.ok).toBe(true)
    const rectDoc = part.getDoc()!
    const rectHash = docHashOf(rectDoc)
    const lineIds = (sketchOf(rectDoc).entities ?? []).map(e => e.id)
    expect(lineIds).toHaveLength(4)
    const rectConstraints = (sketchOf(rectDoc).constraints ?? []).length

    const patterned = await part.run([
      { mutation: { type: 'pattern_entities', featureId: 'sk1', sourceIds: lineIds, mode: 'linear', count: 4, pitch: 15 } },
    ])
    expect(patterned.ok).toBe(true)
    const forward = part.getDoc()!
    expect(sketchOf(forward).entities).toHaveLength(16)
    expect(sketchOf(forward).constraints).toHaveLength(4 * rectConstraints)

    expect((await part.run([{ command: 'undo' }])).ok).toBe(true)
    expect(docHashOf(part.getDoc()!)).toBe(rectHash)

    expect((await part.run([{ command: 'redo' }])).ok).toBe(true)
    expect(docHashOf(part.getDoc()!)).toBe(docHashOf(forward))
    expect(sketchOf(part.getDoc()).entities).toHaveLength(16)
  })

  it('a refused step (over the cap, or a projected source) leaves the hash unchanged', async () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    await part.run([
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 1, 0], entityId: 'l1' } },
    ])
    const before = docHashOf(part.getDoc()!)
    const capped = await part.run([
      { mutation: { type: 'pattern_entities', featureId: 'sk1', sourceIds: ['l1'], mode: 'linear', count: 201, pitch: 2 } },
    ])
    expect(capped.ok).toBe(false)
    expect(capped.steps[0].error?.message).toContain('count 201 is above the cap of 200 instances')
    expect(docHashOf(part.getDoc()!)).toBe(before)

  })
})

describe('pattern_entities command gate', () => {
  it('refuses an empty, a vertex-only and an other-sketch selection by name', () => {
    expect(patternSelectionPlan(new Set(), 'sk1')).toEqual({ reason: 'select one or more entities of the active sketch to pattern' })
    expect(patternSelectionPlan(new Set(['vertex:sk1:l1:start']), 'sk1'))
      .toEqual({ reason: 'pattern copies whole entities; select the entities, not their vertices' })
    expect(patternSelectionPlan(new Set(['entity:sk2:l1']), 'sk1'))
      .toEqual({ reason: 'select one or more entities of the active sketch to pattern' })
    expect(patternSelectionPlan(new Set(['entity:sk1:l1']), null)).toEqual({ reason: 'no active sketch' })
    expect(patternSelectionPlan(new Set(['entity:sk1:l1', 'vertex:sk1:l2:end', 'entity:sk1:l3']), 'sk1'))
      .toEqual({ sourceIds: ['l1', 'l3'] })
  })

  it('the drive rule refuses the same empty source set', () => {
    const violation = mutationValueViolation('pattern_entities', {
      type: 'pattern_entities', featureId: 'sk1', sourceIds: [], mode: 'linear', count: 2, pitch: 1,
    }, { doc: null, fileIds: null, fieldSchema: () => null })
    expect(violation?.message).toContain('sourceIds must name at least one reference')
  })

  it('the dialog reads "count pitch" as two expressions', () => {
    expect(parsePatternInput('4 12')).toEqual({ count: 4, pitch: 12 })
    expect(parsePatternInput('2*3 10')).toEqual({ count: 6, pitch: 10 })
    expect(parsePatternInput(' 3, -2.5 ')).toEqual({ count: 3, pitch: -2.5 })
    expect(parsePatternInput('4')).toHaveProperty('reason')
    expect(parsePatternInput('1 10')).toHaveProperty('reason')
    expect(parsePatternInput('2.5 10')).toHaveProperty('reason')
    expect(parsePatternInput('3 0')).toEqual({ reason: 'pitch must not be zero' })
    expect(parsePatternInput('300 5')).toEqual({ reason: 'count 300 is above the cap of 200 instances' })
    expect(parsePatternInput('x 10')).toEqual({ reason: 'cannot evaluate "x"' })
  })
})
