// Freezing a face projection goes through the ordinary delete mutation, so one
// undo restores the live constraint and redo freezes the same rows again.

import { describe, it, expect } from 'vitest'
import { createDocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import type { PartDoc, SketchData } from '@/types/cad'

const CID = 'proj_face'
const MEMBER = 'proj_face.e6ad6abc'
const TOKEN = 'u|e_aaaabbbb'

function doc(): PartDoc {
  return {
    version: 7, kind: 'part',
    features: [{
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [], initial: {},
      constraints: [{ id: CID, kind: 'projection', source: '?face', members: { [TOKEN]: MEMBER } }],
    }],
  } as unknown as PartDoc
}

function makeSession() {
  const cell: { current: PartDoc | null } = { current: doc() }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve: createFakeSolveScheduler<PartDoc>(),
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
    dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
  })
  return { session, cell }
}

function sketch(cell: { current: PartDoc | null }) {
  const feature = (cell.current?.features ?? []).find(f => f.id === 'sk1')
  if (feature?.kind !== 'sketch') throw new Error('no sketch')
  return feature
}

describe('freeze projection undo and redo', () => {
  it('one undo restores the live constraint and redo freezes the same rows', () => {
    const { session, cell } = makeSession()
    const applied = session.execute({
      type: 'delete',
      targets: [`constraint:sk1:${CID}`],
      materialize: [{ id: MEMBER, kind: 'line', params: [0, 0, 10, 0] }],
    })
    expect(applied.ok).toBe(true)
    expect(sketch(cell).constraints?.some(c => c.id === CID)).toBe(false)
    expect(sketch(cell).entities).toEqual([{ id: MEMBER, kind: 'line' }])
    expect(sketch(cell).initial?.[MEMBER]).toEqual([0, 0, 10, 0])

    session.undo()
    expect(sketch(cell).constraints?.some(c => c.id === CID)).toBe(true)
    expect(sketch(cell).entities).toEqual([])
    expect(sketch(cell).initial?.[MEMBER]).toBeUndefined()

    session.redo()
    expect(sketch(cell).constraints?.some(c => c.id === CID)).toBe(false)
    expect(sketch(cell).entities).toEqual([{ id: MEMBER, kind: 'line' }])
    expect(sketch(cell).initial?.[MEMBER]).toEqual([0, 0, 10, 0])
  })
})
