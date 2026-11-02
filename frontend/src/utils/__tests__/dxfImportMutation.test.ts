// The DXF import at the document boundary: the writer appends authored
// entities with freshly minted ids, a refused file writes nothing, the unit
// rule applies to the document, and one mutation is one undo entry. The drive
// value rule is exercised here too because it is the other caller of the same
// parser.

import { describe, it, expect } from 'vitest'
import { createDocSession, type DocSession, type EditorFacts } from '@/session/DocSession'
import type { DirtyFacts } from '@/session/dirty'
import type { PartDoc, SketchData } from '@/types/cad'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { applyImportDxf } from '@/utils/yamlMutations'
import { validateMutation } from '@/drive/mutationCatalog'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'

function entity(type: string, ...groups: Array<[number, string | number]>): string[] {
  return ['0', type, ...groups.flatMap(([code, value]) => [String(code), String(value)])]
}

function dxf(entities: string[][], insunits?: number): string {
  const groups: string[] = ['0', 'SECTION', '2', 'HEADER']
  if (insunits !== undefined) groups.push('9', '$INSUNITS', '70', String(insunits))
  groups.push('0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES')
  for (const rows of entities) groups.push(...rows)
  groups.push('0', 'ENDSEC', '0', 'EOF')
  return groups.join('\n') + '\n'
}

const line = (x1: number, y1: number, x2: number, y2: number) =>
  entity('LINE', [10, x1], [20, y1], [11, x2], [21, y2])

function sketchDoc(initial: Record<string, number[]> = {}): PartDoc {
  const ids = Object.keys(initial)
  return makeDoc(makeSketch('sk', {
    entities: ids.map(id => ({ id, kind: 'line' })),
    initial,
  }))
}

function docSketch(doc: PartDoc) {
  const feature = doc.features?.find(f => f.id === 'sk')
  if (!feature || feature.kind !== 'sketch') throw new Error('fixture lost its sketch')
  return feature
}

interface Engine {
  session: DocSession
  cell: { current: PartDoc | null }
  solve: ReturnType<typeof createFakeSolveScheduler<PartDoc>>
}

function makeEngine(doc: PartDoc): Engine {
  const cell: { current: PartDoc | null } = { current: doc }
  const solve = createFakeSolveScheduler<PartDoc>()
  const facts: EditorFacts = { editingFeatureId: null, rollbackPosition: null }
  const dirty: DirtyFacts = { dirty: false, saves: 0, savedHash: null }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve,
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => facts,
    dirtyFacts: () => dirty,
  })
  return { session, cell, solve }
}

describe('applyImportDxf', () => {
  it('appends every parsed entity with a fresh id beside the authored geometry', () => {
    const doc = sketchDoc({ existing: [0, 0, 1, 0] })
    applyImportDxf(doc, 'sk', dxf([
      line(0, 0, 10, 0),
      entity('CIRCLE', [10, 5], [20, 5], [40, 2]),
    ]))
    const sketch = docSketch(doc)
    expect(sketch.entities).toHaveLength(3)
    expect(sketch.entities?.map(e => e.kind)).toEqual(['line', 'line', 'circle'])
    const ids = sketch.entities?.map(e => e.id) ?? []
    expect(new Set(ids).size).toBe(3)
    expect(ids[0]).toBe('existing')
    expect(sketch.initial?.[ids[1]]).toEqual([0, 0, 10, 0])
    expect(sketch.initial?.[ids[2]]).toEqual([5, 5, 2])
  })

  it('rounds the parsed coordinates to the document precision', () => {
    const doc = sketchDoc()
    applyImportDxf(doc, 'sk', dxf([line(0, 0, 0.351324026, 0)]))
    const id = docSketch(doc).entities?.[0]?.id as string
    expect((docSketch(doc).initial?.[id] as number[])[2]).toBe(0.351324)
  })

  it('converts the file unit into the document unit', () => {
    const doc = sketchDoc()
    doc.length_unit = 'inch'
    applyImportDxf(doc, 'sk', dxf([line(0, 0, 25.4, 0)], 4))
    const id = docSketch(doc).entities?.[0]?.id as string
    expect((docSketch(doc).initial?.[id] as number[])[2]).toBe(1)
  })

  it('leaves the sketch untouched when the file is refused', () => {
    // The fixture omits the containers on purpose: a refused import must not
    // materialize them either, or the no-op would become a real doc write.
    const doc = makeDoc({ id: 'sk', kind: 'sketch' })
    const before = JSON.stringify(doc)
    applyImportDxf(doc, 'sk', dxf([entity('INSERT', [2, 'BLOCK'])]))
    expect(JSON.stringify(doc)).toBe(before)
    expect(docSketch(doc).entities).toBeUndefined()
  })

  it('ignores a feature id that is not a sketch', () => {
    const doc = makeDoc({ id: 'pl', kind: 'plane' })
    applyImportDxf(doc, 'pl', dxf([line(0, 0, 10, 0)]))
    expect(doc.features?.[0]).not.toHaveProperty('entities')
  })
})

describe('import_dxf at the drive boundary', () => {
  it('refuses an unsupported entity with a named reason', () => {
    const doc = sketchDoc()
    const result = validateMutation(
      { type: 'import_dxf', featureId: 'sk', content: dxf([entity('INSERT', [2, 'BLOCK'])]) },
      { doc },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid-mutation')
    expect(result.error.message).toMatch(/INSERT/)
  })

  it('refuses a feature id that names no sketch', () => {
    const result = validateMutation(
      { type: 'import_dxf', featureId: 'nope', content: dxf([line(0, 0, 1, 0)]) },
      { doc: sketchDoc() },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unknown-target')
    expect(result.error.message).toMatch(/no sketch feature "nope"/)
  })

  it('admits a valid file and keeps the content as the mutation field', () => {
    const content = dxf([line(0, 0, 1, 0)])
    const result = validateMutation({ type: 'import_dxf', featureId: 'sk', content }, { doc: sketchDoc() })
    expect(result).toEqual({ ok: true, mutation: { type: 'import_dxf', featureId: 'sk', content } })
  })
})

describe('import_dxf is one undo entry', () => {
  it('reports the minted entity ids and undo removes the whole import', () => {
    const engine = makeEngine(sketchDoc({ existing: [0, 0, 1, 0] }))
    const content = dxf([
      line(0, 0, 10, 0),
      line(10, 0, 10, 10),
      entity('ARC', [10, 0], [20, 0], [40, 10], [50, 0], [51, 90]),
    ])
    const result = engine.session.execute({ type: 'import_dxf', featureId: 'sk', content })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const sketch = docSketch(engine.cell.current as PartDoc)
    const importedIds = (sketch.entities ?? []).map(e => e.id).filter(id => id !== 'existing')
    expect(result.createdIds).toEqual(importedIds)
    expect(importedIds).toHaveLength(3)
    expect(engine.session.historyEntries().undo).toHaveLength(1)

    expect(engine.session.undo()).toBe(true)
    const restored = docSketch(engine.cell.current as PartDoc)
    expect(restored.entities?.map(e => e.id)).toEqual(['existing'])

    expect(engine.session.redo()).toBe(true)
    expect(docSketch(engine.cell.current as PartDoc).entities).toHaveLength(4)
  })

  it('a refused file records no undo entry', () => {
    const engine = makeEngine(sketchDoc())
    const result = engine.session.execute({
      type: 'import_dxf',
      featureId: 'sk',
      content: dxf([entity('INSERT', [2, 'BLOCK'])]),
    })
    expect(result.ok).toBe(true)
    expect(docSketch(engine.cell.current as PartDoc).entities).toEqual([])
    expect(engine.session.historyEntries().undo).toHaveLength(0)
  })
})
