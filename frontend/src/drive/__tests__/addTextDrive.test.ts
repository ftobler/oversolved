// @vitest-environment node
//
// add_text through the headless session: one step is one undo entry however
// many outlines it writes, the reply counts the entities instead of listing
// their ids (the bulk-add reply shape import_dxf set), and a refused step writes
// nothing. Solves fail benignly here (OCC is not injected); the real kernel
// suite is textExtrudeReal.test.ts.

import { describe, it, expect } from 'vitest'
import { createHeadlessPart } from '../headlessPart'
import { docHashOf } from '../docHash'
import { textEntityCount } from '@/utils/geometry/textExpand'
import type { PartDoc, SketchFeature } from '@/types/cad'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}

const sketchOf = (doc: PartDoc | null): SketchFeature =>
  doc!.features!.find(f => f.id === 'sk1') as SketchFeature

describe('add_text session history', () => {
  it('reports createdCount, not ids, and the document holds exactly that many entities', async () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    expect((await part.run([
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, -5, 40, -5], entityId: 'base' } },
    ])).ok).toBe(true)
    const before = docHashOf(part.getDoc()!)

    const run = await part.run([
      { mutation: { type: 'add_text', featureId: 'sk1', text: 'Tag 42', origin: [2, 0], size: 8, align: 'left' } },
    ])
    expect(run.ok).toBe(true)
    const expected = textEntityCount('Tag 42')
    expect(run.steps[0].createdIds).toEqual([])
    expect(run.steps[0].createdCount).toBe(expected)
    const forward = part.getDoc()!
    const ids = (sketchOf(forward).entities ?? []).map(e => e.id)
    expect(ids).toHaveLength(1 + expected)
    expect(ids[0]).toBe('base')

    expect((await part.run([{ command: 'undo' }])).ok).toBe(true)
    expect(docHashOf(part.getDoc()!)).toBe(before)
    expect((await part.run([{ command: 'redo' }])).ok).toBe(true)
    expect(docHashOf(part.getDoc()!)).toBe(docHashOf(forward))
  })

  it('a refused character or a missing sketch fails the step by name and leaves the hash', async () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    await part.run([{ mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } }])
    const before = docHashOf(part.getDoc()!)

    const accent = await part.run([{ mutation: { type: 'add_text', featureId: 'sk1', text: 'Café' } }])
    expect(accent.ok).toBe(false)
    expect(accent.steps[0].error?.code).toBe('invalid-mutation')
    expect(accent.steps[0].error?.message).toContain('(U+00E9)')

    const missing = await part.run([{ mutation: { type: 'add_text', featureId: 'sk9', text: 'Hi' } }])
    expect(missing.ok).toBe(false)
    expect(missing.steps[0].error?.code).toBe('unknown-target')
    expect(missing.steps[0].error?.message).toContain('"sk9"')

    // A run of only spaces would write nothing; it is refused rather than
    // landing as an undo entry that changes nothing.
    const spaces = await part.run([{ mutation: { type: 'add_text', featureId: 'sk1', text: '   ' } }])
    expect(spaces.ok).toBe(false)
    expect(spaces.steps[0].error?.message).toContain('draws no outline')

    expect(docHashOf(part.getDoc()!)).toBe(before)
    // Nothing above reached history: the one undo removes the sketch itself.
    expect((await part.run([{ command: 'undo' }])).ok).toBe(true)
    expect(part.getDoc()!.features ?? []).toEqual([])
  })
})
