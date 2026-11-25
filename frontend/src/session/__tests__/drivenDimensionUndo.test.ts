// @vitest-environment node
//
// The reference toggle is a normal document mutation, so undo/redo come from
// DocSession and need no special path in the solver write-back.
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchData } from '@/types/cad'
import { createDocSession, type EditorFacts } from '../DocSession'
import { type DirtyFacts } from '../dirty'
import { createFakeSolveScheduler } from './fakeSolveScheduler'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'

const drivenDoc = (): PartDoc => makeDoc(makeSketch('sk1', {
  entities: [{ id: 'l1', kind: 'line' }],
  initial: { l1: [0, 0, 10, 0] },
  constraints: [{ id: 'c_len', kind: 'length', target: '$l1', value: 10 }],
}))

const harness = (doc: PartDoc = drivenDoc()) => {
  const cell: { current: PartDoc | null } = { current: doc }
  const solve = createFakeSolveScheduler<PartDoc>()
  const facts: EditorFacts = { editingFeatureId: null, rollbackPosition: null }
  const dirty: DirtyFacts = { dirty: false, saves: 0, savedHash: null }
  const results = { current: {} as Record<string, SketchData> }
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve,
    solveResults: { get: () => results.current, set: next => { results.current = next } },
    editorFacts: () => facts,
    dirtyFacts: () => dirty,
  })
  return { session, cell }
}

const constraintOf = (doc: PartDoc | null) =>
  (doc?.features?.[0] as { constraints?: Array<{ id: string; driven?: true; value?: number }> })?.constraints?.[0]

describe('driven dimension undo/redo', () => {
  it('undo and redo restore each toggle step, including the written value', () => {
    const { session, cell } = harness()
    session.execute({ type: 'set_constraint_driven', featureId: 'sk1', constraintId: 'c_len', driven: true, value: 10 })
    expect(constraintOf(cell.current)).toMatchObject({ driven: true, value: 10 })

    session.execute({ type: 'set_constraint_driven', featureId: 'sk1', constraintId: 'c_len', driven: false, value: 12.5 })
    expect(constraintOf(cell.current)).toMatchObject({ value: 12.5 })
    expect(constraintOf(cell.current)?.driven).toBeUndefined()

    session.undo()
    expect(constraintOf(cell.current)).toMatchObject({ driven: true, value: 10 })
    session.undo()
    expect(constraintOf(cell.current)?.driven).toBeUndefined()
    session.redo()
    expect(constraintOf(cell.current)).toMatchObject({ driven: true, value: 10 })
    session.redo()
    expect(constraintOf(cell.current)).toMatchObject({ value: 12.5 })
  })

  it('an add_constraint carrying driven is one undoable entry with the flag', () => {
    const { session, cell } = harness()
    const result = session.execute({
      type: 'add_constraint', featureId: 'sk1', kind: 'point_distance_x',
      targets: ['vertex:sk1:l1:start', '@builtin_origin'], value: 4, sign: 1, driven: true,
    })
    expect(result.ok).toBe(true)
    const added = (cell.current?.features?.[0] as { constraints?: Array<{ kind: string; driven?: true }> })
      ?.constraints?.find(c => c.kind === 'point_distance_x')
    expect(added?.driven).toBe(true)
    session.undo()
    expect((cell.current?.features?.[0] as { constraints?: Array<{ kind: string }> })?.constraints
      ?.some(c => c.kind === 'point_distance_x')).toBe(false)
  })
})
