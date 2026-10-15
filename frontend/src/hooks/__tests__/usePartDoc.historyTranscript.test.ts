// The frozen session/history transcript table: one row per promised behaviour
// from the history-behaviour-freeze plan, driven through the real hook
// composition (historyTranscript's driver) over the real mutation handlers.
// Deep equality only. Rows whose observation needs a seam the transcript cannot
// express (the fail-loud guards, the drag solve options, the teardown's pick
// boundary, the assembly engine) are dedicated `it` blocks below the table.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'

import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useAssemblyUndoRedo, decideAssemblyMutation } from '@/hooks/useAssemblyUndoRedo'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import type { AssemblyDoc, PartDoc, Mutation } from '@/types/cad'
import { docRef, reSolve, renameTo, resetHarness } from './usePartDoc.undoHarness'
import { runPartTranscript, type TranscriptResult, type TranscriptStep } from './historyTranscript'
import { useEditorState } from '@/hooks/useEditorState'

// The fail-loud guard is mocked with a controllable implementation: the
// dev/test rows make it throw (the real test-mode behaviour), the prod row
// makes it a silent no-op.
const { failLoudMock } = vi.hoisted(() => ({ failLoudMock: vi.fn() }))

vi.mock('@/stores/stateInvariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/stateInvariants')>()
  return { ...actual, failLoud: failLoudMock }
})

// The no-op guard's bodyId diagnostic moved into the shared session module,
// which reads failLoud from its source in utils/invariants; the hook keeps the
// store re-export for its own guards, so both paths point at the mock here.
vi.mock('@/utils/invariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/invariants')>()
  return { ...actual, failLoud: failLoudMock }
})

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

// ─── Fixtures and readers ───

const extrudeDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first', extrude: { sketch: [], distance: 1 } }],
})

const colorDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  part_style: { b1: { color: '#ff0000' } },
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first', extrude: { sketch: [], distance: 1 } }],
})

const variableDoc = (): PartDoc => makeDoc({
  id: 'v1', kind: 'variable', label: 'v1', variable: { expression: '10' },
})

const rollbackDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  rollback: 2,
  features: [
    { id: 'f1', kind: 'sketch' },
    { id: 'f2', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
    { id: 'f3', kind: 'fillet', fillet: { edges: [], radius: 1 } },
  ],
})

const staleRollbackDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  rollback: 99,
  features: [
    { id: 'f1', kind: 'sketch' },
    { id: 'f2', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
    { id: 'f3', kind: 'fillet', fillet: { edges: [], radius: 1 } },
  ],
})

const bareSketchDoc = (): PartDoc => makeDoc(makeSketch('sk1'))

const pointSketchDoc = (): PartDoc => makeDoc(makeSketch('sk1', {
  entities: [{ id: 'l1', kind: 'line' }],
  initial: { l1: [0, 0, 10, 0] },
}))

const filletDoc = (): PartDoc => makeDoc({
  id: 'f1', kind: 'fillet', fillet: { edges: ['?e1', '?e2'], radius: 1 },
})

const profileDoc = (): PartDoc => makeDoc({
  id: 'ex1', kind: 'extrude',
  extrude: { sketch: ['@sk1', '@sk2'], distance: 10, direction: 'normal' },
})

const partStyleDoc = (): PartDoc => ({ ...makeDoc(), part_style: { b1: { color: '#ff0000' } } })

const labelOf = (d: PartDoc | null) =>
  (d?.features?.[0] as { label?: string } | undefined)?.label

const colorOf = (d: PartDoc | null) =>
  (d?.part_style?.b1 as { color?: string } | undefined)?.color

const entitiesOf = (d: PartDoc | null) =>
  (d?.features?.[0] as { entities?: unknown[] } | undefined)?.entities ?? []

const constraintsOf = (d: PartDoc | null) =>
  (d?.features?.[0] as { constraints?: unknown[] } | undefined)?.constraints ?? []

const expressionOf = (d: PartDoc | null) =>
  (d?.features?.[0] as { variable?: { expression?: string } } | undefined)?.variable?.expression

const setColor = (color: string): Mutation =>
  ({ type: 'set_part_color', bodyId: 'b1', color })

const setExpression = (value: string): Mutation =>
  ({ type: 'set_variable_field', featureId: 'v1', field: 'expression', value })

const projectedEdge = (entityId: string): Mutation =>
  ({ type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:1', entityId })

const lengthConstraint = (target: string): Mutation =>
  ({ type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: [target], value: 10 })

const addPoint = (entityId: string, params: [number, number]): Mutation =>
  ({ type: 'add_entity', featureId: 'sk1', kind: 'point', params, entityId })

interface TranscriptRow {
  id: string
  name: string
  makeDoc: () => PartDoc
  steps: TranscriptStep[]
  check: (result: TranscriptResult, pre: PartDoc) => void
}

const batches = (n: number): TranscriptStep[] => Array.from({ length: n }, (_, i) => ({
  kind: 'mutation' as const,
  mutation: addPoint(`p${i}`, [i, 0]),
}))

const ROWS: TranscriptRow[] = [
  // ─── history basics ───
  {
    id: 'T01',
    name: 'a push clears the redo branch',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'mutation', mutation: renameTo('a') },
      { kind: 'mutation', mutation: renameTo('b') },
      { kind: 'undo' },
      { kind: 'mutation', mutation: renameTo('c') },
    ],
    check: (result) => {
      expect(result.undoLabels).toEqual(['rename extrude-1 to a', 'rename extrude-1 to c'])
      expect(result.redoLabels).toEqual([])
      expect(labelOf(result.doc)).toBe('c')
    },
  },
  {
    id: 'T02',
    name: 'undo and redo on an empty stack are inert',
    makeDoc: extrudeDoc,
    steps: [{ kind: 'undo' }, { kind: 'redo' }],
    check: (result, pre) => {
      expect(result.doc).toEqual(pre)
      expect(result.undoLabels).toEqual([])
      expect(result.redoLabels).toEqual([])
      expect(result.dirty).toBe(false)
      expect(result.editorState).toEqual({
        editingFeatureId: null,
        rollbackPosition: null,
        pickBoundary: null,
      })
    },
  },
  {
    id: 'T03',
    name: 'the history caps at 50 entries and conserves the pair',
    makeDoc: pointSketchDoc,
    steps: [...batches(55), { kind: 'undo' }, { kind: 'undo' }, { kind: 'redo' }],
    check: (result) => {
      // 55 pushes leave the newest 50; two undos and one redo shift one across
      // each, so the total can never grow past the cap.
      expect(result.undoLabels).toHaveLength(49)
      expect(result.redoLabels).toHaveLength(1)
      expect(result.undoLabels.length + result.redoLabels.length).toBeLessThanOrEqual(50)
    },
  },
  {
    id: 'T04',
    name: 'a redo mid-session commits the session, tears the editor down and stays a no-op',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'mutation', mutation: renameTo('a') },
      { kind: 'undo' },
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('in-edit') },
      { kind: 'redo' },
    ],
    check: (result) => {
      // The session's aggregate is the newest entry; its push cleared the redo
      // branch, so the redo itself could not move. The editor still came down
      // (openWorkCommitted), the edits stay reachable by a plain undo, and the
      // live doc is exactly the post-edit one.
      expect(labelOf(result.doc)).toBe('in-edit')
      expect(result.undoLabels).toEqual(['edit extrude-1'])
      expect(result.redoLabels).toEqual([])
      expect(result.editorState.editingFeatureId).toBeNull()
      expect(result.editorState.pickBoundary).toBeNull()
      expect(result.dirty).toBe(true)
    },
  },
  {
    id: 'T05',
    name: 'undo mid-session commits the session, then reverts exactly that work',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('in-edit') },
      { kind: 'undo' },
    ],
    check: (result, pre) => {
      expect(result.doc).toEqual(pre)
      expect(result.undoLabels).toEqual([])
      expect(result.redoLabels).toEqual(['edit extrude-1'])
      expect(result.editorState.editingFeatureId).toBeNull()
      expect(result.dirty).toBe(true)
    },
  },
  {
    id: 'T06',
    name: 'undo restores the rollback bar from the entry doc, clamped to its feature list',
    makeDoc: staleRollbackDoc,
    steps: [{ kind: 'mutation', mutation: renameTo('edited') }, { kind: 'undo' }],
    check: (result, pre) => {
      // The restored entry parks rollback 99 in a 3-feature list; the bar is
      // clamped, the immutable entry doc is not rewritten.
      expect(result.doc).toEqual(pre)
      expect(result.doc?.rollback).toBe(99)
      expect(result.editorState.rollbackPosition).toBe(3)
    },
  },
  {
    id: 'T07',
    name: 'undo re-solves the restored doc',
    makeDoc: extrudeDoc,
    steps: [{ kind: 'mutation', mutation: renameTo('a') }, { kind: 'undo' }],
    check: (_result, pre) => {
      const restored = reSolve.mock.calls.at(-1)?.[0] as PartDoc | undefined
      expect(restored).toEqual(pre)
    },
  },

  // ─── sketch snapshot slot ───
  {
    id: 'T08',
    name: 'session start saves the stack snapshot and cancel restores it',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'mutation', mutation: renameTo('kept') },
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('discarded') },
      { kind: 'sessionCancel' },
    ],
    check: (result) => {
      expect(labelOf(result.doc)).toBe('kept')
      expect(result.undoLabels).toEqual(['rename extrude-1 to kept'])
      expect(result.redoLabels).toEqual([])
      // The earlier rename is still unsaved; the pin was taken after it.
      expect(result.dirty).toBe(true)
    },
  },
  {
    id: 'T09',
    name: 'session commit clears the snapshot so a later cancel cannot rewind',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('committed') },
      { kind: 'sessionCommit' },
      { kind: 'sessionCancel' },
    ],
    check: (result) => {
      // The commit pushed the aggregate and dropped the slot; the stale Cancel
      // is inert: no rewind, no new entry.
      expect(labelOf(result.doc)).toBe('committed')
      expect(result.undoLabels).toEqual(['edit extrude-1'])
      expect(result.redoLabels).toEqual([])
    },
  },
  {
    id: 'T10',
    name: 'a suppressed session folds every edit into one aggregate entry',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('a') },
      { kind: 'mutation', mutation: renameTo('b') },
      { kind: 'sessionCommit' },
    ],
    check: (result) => {
      expect(result.undoLabels).toEqual(['edit extrude-1'])
      expect(labelOf(result.doc)).toBe('b')
    },
  },
  {
    id: 'T11',
    name: 'a sketch session keeps one entry per action and no aggregate',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'sessionStart', suppressed: false, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('a') },
      { kind: 'mutation', mutation: renameTo('b') },
      { kind: 'sessionCommit' },
    ],
    check: (result) => {
      expect(result.undoLabels).toEqual(['rename extrude-1 to a', 'rename extrude-1 to b'])
    },
  },
  {
    id: 'T12',
    name: 'cancelling a sketch session restores the parked redo branch too',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'mutation', mutation: renameTo('a') },
      { kind: 'undo' },
      { kind: 'sessionStart', suppressed: false, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('b') },
      { kind: 'sessionCancel' },
    ],
    check: (result) => {
      expect(labelOf(result.doc)).toBe('first')
      expect(result.undoLabels).toEqual([])
      expect(result.redoLabels).toEqual(['rename extrude-1 to a'])
    },
  },
  {
    id: 'T13',
    name: 'a suppressed session that nets to zero commits nothing and stays clean',
    makeDoc: variableDoc,
    steps: [
      { kind: 'sessionStart', suppressed: true, featureId: 'v1' },
      { kind: 'mutation', mutation: setExpression('20') },
      { kind: 'mutation', mutation: setExpression('10') },
      { kind: 'sessionCommit' },
    ],
    check: (result) => {
      expect(expressionOf(result.doc)).toBe('10')
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },

  // ─── preview semantics ───
  {
    id: 'T14',
    name: 'a pure preview swallows its scope mutations and commits one labelled entry',
    makeDoc: colorDoc,
    steps: [
      { kind: 'previewStart' },
      { kind: 'mutation', mutation: setColor('#00ff00') },
      { kind: 'mutation', mutation: { type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 } },
      { kind: 'previewCommit', mutation: setColor('#00ff00') },
    ],
    check: (result) => {
      expect(result.undoLabels).toEqual(['edit b1: color, transparency'])
      expect(colorOf(result.doc)).toBe('#00ff00')
    },
  },
  {
    id: 'T15',
    name: 'a non-scope mutation escapes and auto-commits the preview first',
    makeDoc: colorDoc,
    steps: [
      { kind: 'previewStart' },
      { kind: 'mutation', mutation: setColor('#00ff00') },
      { kind: 'mutation', mutation: renameTo('escaped') },
    ],
    check: (result) => {
      expect(result.undoLabels).toEqual(['edit b1: color', 'rename extrude-1 to escaped'])
      expect(colorOf(result.doc)).toBe('#00ff00')
      expect(labelOf(result.doc)).toBe('escaped')
    },
  },
  {
    id: 'T16',
    name: 'after an escape the popover cancel is inert',
    makeDoc: colorDoc,
    steps: [
      { kind: 'previewStart' },
      { kind: 'mutation', mutation: setColor('#00ff00') },
      { kind: 'mutation', mutation: renameTo('escaped') },
      { kind: 'previewCancel' },
    ],
    check: (result) => {
      // The escape consumed the preview, so the normal Cancel rewinds nothing.
      expect(colorOf(result.doc)).toBe('#00ff00')
      expect(result.undoLabels).toEqual(['edit b1: color', 'rename extrude-1 to escaped'])
    },
  },
  {
    id: 'T17',
    name: 'cancel rewinds the live doc to the pre-preview baseline and restores the pin',
    makeDoc: colorDoc,
    steps: [
      { kind: 'previewStart' },
      { kind: 'mutation', mutation: setColor('#00ff00') },
      { kind: 'previewCancel' },
    ],
    check: (result, pre) => {
      expect(result.doc).toEqual(pre)
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },
  {
    id: 'T18',
    name: 'a preview open at session start resolves with its own entry before the session opens',
    makeDoc: colorDoc,
    steps: [
      { kind: 'previewStart' },
      { kind: 'mutation', mutation: setColor('#00ff00') },
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('in-session') },
      { kind: 'sessionCancel' },
    ],
    check: (result) => {
      // The colour kept its own entry (parked with the session's stacks, so the
      // cancel left it), and the session baseline was taken after that entry.
      expect(result.undoLabels).toEqual(['edit b1: color'])
      expect(colorOf(result.doc)).toBe('#00ff00')
      expect(labelOf(result.doc)).toBe('first')
    },
  },
  {
    id: 'T19',
    name: 'a suppressed session swallows a body-style edit into its aggregate',
    makeDoc: colorDoc,
    steps: [
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: setColor('#00ff00') },
      { kind: 'sessionCommit' },
    ],
    check: (result) => {
      expect(result.undoLabels).toEqual(['edit extrude-1'])
      expect(colorOf(result.doc)).toBe('#00ff00')
    },
  },

  // ─── brep withhold ───
  {
    id: 'T20',
    name: 'a brep pick plus its OK is one entry and leaves no orphan projection',
    makeDoc: bareSketchDoc,
    steps: [
      { kind: 'brepArm' },
      { kind: 'mutation', mutation: projectedEdge('p1') },
      { kind: 'mutation', mutation: lengthConstraint('entity:sk1:p1') },
      { kind: 'undo' },
    ],
    check: (result) => {
      // The projection pushed nothing; the dimension commit pushed one entry
      // keyed to the pre-pick doc, so the single undo removes both.
      expect(entitiesOf(result.doc)).toHaveLength(0)
      expect(constraintsOf(result.doc)).toHaveLength(0)
      expect(result.undoLabels).toEqual([])
      expect(result.redoLabels).toEqual(['add length constraint in sk1'])
    },
  },
  {
    id: 'T21',
    name: 'a mid-gesture steal owns the projection and later undos stay per step',
    makeDoc: bareSketchDoc,
    steps: [
      { kind: 'brepArm' },
      { kind: 'mutation', mutation: projectedEdge('p1') },
      { kind: 'mutation', mutation: { type: 'rename_feature', featureId: 'sk1', label: 'steal' } },
      { kind: 'mutation', mutation: lengthConstraint('entity:sk1:p1') },
      { kind: 'undo' },
      { kind: 'undo' },
    ],
    check: (result) => {
      expect(entitiesOf(result.doc)).toHaveLength(1)
      expect(constraintsOf(result.doc)).toHaveLength(0)
      expect(labelOf(result.doc)).toBeUndefined()
      expect(result.redoLabels).toEqual(['add length constraint in sk1', 'rename sk1 to steal'])
    },
  },
  {
    id: 'T22',
    name: 'a mid-gesture no-op consumes the arm so the next real edit pushes',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'brepArm' },
      { kind: 'mutation', mutation: renameTo('first') },
      { kind: 'mutation', mutation: renameTo('second') },
    ],
    check: (result) => {
      expect(result.undoLabels).toEqual(['rename extrude-1 to second'])
      expect(labelOf(result.doc)).toBe('second')
    },
  },
  {
    id: 'T23',
    name: 'undo mid-gesture banks only the pending projection',
    makeDoc: pointSketchDoc,
    steps: [
      { kind: 'mutation', mutation: addPoint('pt1', [1, 2]) },
      { kind: 'brepArm' },
      { kind: 'mutation', mutation: projectedEdge('p1') },
      { kind: 'undo' },
    ],
    check: (result) => {
      // The earlier point (with the fixture's line) survives; the pending
      // projection became its own entry and the undo reverted exactly it.
      expect(entitiesOf(result.doc)).toHaveLength(2)
      expect(result.undoLabels).toEqual(['add point in sk1'])
      expect(result.redoLabels).toEqual(['add projected edge'])
    },
  },
  {
    id: 'T24',
    name: 'cancelling the arm drops the withhold so later edits push normally',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'brepArm' },
      { kind: 'brepCancel' },
      { kind: 'mutation', mutation: renameTo('after') },
    ],
    check: (result) => {
      expect(result.undoLabels).toEqual(['rename extrude-1 to after'])
    },
  },

  // ─── rollback mirror ───
  {
    id: 'T25',
    name: 'the mirror writes the parked position into the doc',
    makeDoc: staleRollbackDoc,
    steps: [{ kind: 'rollback', position: 2 }],
    check: (result) => {
      expect(result.doc?.rollback).toBe(2)
      expect(result.editorState.rollbackPosition).toBe(2)
      expect(result.undoLabels).toEqual(['move rollback to 2'])
      expect(result.dirty).toBe(true)
    },
  },
  {
    id: 'T26',
    name: 'undo restores the pre-park doc and moves the bar to the restored end',
    makeDoc: staleRollbackDoc,
    steps: [{ kind: 'rollback', position: 2 }, { kind: 'undo' }],
    check: (result, pre) => {
      expect(result.doc).toEqual(pre)
      expect(result.doc?.rollback).toBe(99)
      expect(result.editorState.rollbackPosition).toBe(3)
      expect(result.redoLabels).toEqual(['move rollback to 2'])
    },
  },

  // ─── no-op guard classes ───
  {
    id: 'T27',
    name: 'a pinned same-value setter pushes nothing and stays clean',
    makeDoc: profileDoc,
    steps: [
      { kind: 'mutation', mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 10 } },
    ],
    check: (result, pre) => {
      expect(result.doc).toEqual(pre)
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },
  {
    id: 'T28',
    name: 'a same-value body-style write pushes nothing and stays clean',
    makeDoc: partStyleDoc,
    steps: [{ kind: 'mutation', mutation: setColor('#ff0000') }],
    check: (result) => {
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },
  {
    id: 'T29',
    name: 'a deliberately unguarded no-op still lands its entry',
    makeDoc: extrudeDoc,
    steps: [{ kind: 'mutation', mutation: { type: 'delete_feature', featureId: 'ghost' } }],
    check: (result, pre) => {
      // delete_feature is classified false and outside the whole-doc guard, so
      // the dispatch records itself even though the doc did not change.
      expect(result.doc).toEqual(pre)
      expect(result.undoLabels).toEqual(['delete feature ghost'])
      expect(result.dirty).toBe(true)
    },
  },
  {
    id: 'T30',
    name: 'the add_* toggle family re-pick is a real change and lands',
    makeDoc: filletDoc,
    steps: [{ kind: 'mutation', mutation: { type: 'add_fillet_edge', featureId: 'f1', edgeQuery: '?e1' } }],
    check: (result) => {
      const fillet = (result.doc?.features?.[0] as { fillet?: { edges: string[] } } | undefined)?.fillet
      expect(fillet?.edges).toEqual(['?e2'])
      expect(result.undoLabels).toEqual(['add fillet edge ?e1'])
      expect(result.dirty).toBe(true)
    },
  },
  {
    id: 'T31',
    name: 'an add_constraint with an unresolvable inferred target pushes nothing',
    makeDoc: pointSketchDoc,
    steps: [{
      kind: 'mutation',
      mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['dock:sk1:noSuchHost'] },
    }],
    check: (result) => {
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },
  {
    id: 'T32',
    name: 'a delete naming an absent entity pushes nothing',
    makeDoc: pointSketchDoc,
    steps: [{ kind: 'mutation', mutation: { type: 'delete', targets: ['entity:sk1:ghost'] } }],
    check: (result) => {
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },
  {
    id: 'T33',
    name: 'a stale remove-by-index pushes nothing',
    makeDoc: profileDoc,
    steps: [{ kind: 'mutation', mutation: { type: 'remove_extrude_profile', featureId: 'ex1', index: 9 } }],
    check: (result) => {
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },

  // ─── group funnel ───
  {
    id: 'T34',
    name: 'a gesture group is one entry that undo reverts whole',
    makeDoc: pointSketchDoc,
    steps: [
      {
        kind: 'group',
        mutations: [
          addPoint('pt1', [5, 5]),
          lengthConstraint('entity:sk1:pt1'),
        ],
      },
      { kind: 'undo' },
    ],
    check: (result) => {
      expect(entitiesOf(result.doc)).toHaveLength(1)
      expect(constraintsOf(result.doc)).toHaveLength(0)
      expect(result.undoLabels).toEqual([])
      expect(result.redoLabels).toEqual(['add point in sk1'])
    },
  },
  {
    id: 'T35',
    name: 'a group whose handlers all no-op pushes nothing and stays clean',
    makeDoc: extrudeDoc,
    steps: [{ kind: 'group', mutations: [renameTo('first')] }],
    check: (result) => {
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },

  // ─── dirty pin and restore ───
  {
    id: 'T36',
    name: 'cancelling a session on a clean doc restores the clean pin',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('discarded') },
      { kind: 'sessionCancel' },
    ],
    check: (result) => {
      expect(result.dirty).toBe(false)
      expect(labelOf(result.doc)).toBe('first')
    },
  },
  {
    id: 'T37',
    name: 'cancelling a session opened on a dirty doc keeps it dirty',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'mutation', mutation: renameTo('kept') },
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('discarded') },
      { kind: 'sessionCancel' },
    ],
    check: (result) => {
      expect(result.dirty).toBe(true)
      expect(labelOf(result.doc)).toBe('kept')
    },
  },
  {
    id: 'T38',
    name: 'a save landing mid-session leaves the cancelled doc dirty',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'sessionStart', suppressed: true, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('saved-then-discarded') },
      { kind: 'save' },
      { kind: 'sessionCancel' },
    ],
    check: (result) => {
      // The save stored the session's edit; the rewind throws those bytes away,
      // so the live doc no longer matches what was stored.
      expect(result.dirty).toBe(true)
      expect(labelOf(result.doc)).toBe('first')
    },
  },
  {
    id: 'T39',
    name: 'committing a sketch session keeps the dirty flag its entries represent',
    makeDoc: extrudeDoc,
    steps: [
      { kind: 'sessionStart', suppressed: false, featureId: 'extrude-1' },
      { kind: 'mutation', mutation: renameTo('edited') },
      { kind: 'sessionCommit' },
    ],
    check: (result) => {
      expect(result.dirty).toBe(true)
      expect(result.undoLabels).toEqual(['rename extrude-1 to edited'])
    },
  },
]

describe.each(ROWS)('$id $name', ({ makeDoc: buildDoc, steps, check }) => {
  it('lands the frozen observable state', () => {
    const pre = buildDoc()
    const result = runPartTranscript(pre, steps)
    check(result, pre)
  })
})

// ─── Rows needing a seam the transcript union does not model ───

describe('teardown, guard and solve-option rows', () => {
  beforeEach(() => {
    resetHarness()
    failLoudMock.mockReset()
    failLoudMock.mockImplementation((msg: string) => { throw new Error(msg) })
    useEditorState.getState().setPickBoundary(null)
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('D01: an undo that moves tears down the pick boundary along with the editing id', () => {
    docRef.current = extrudeDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    useEditorState.getState().setEditingFeatureId('extrude-1')
    useEditorState.getState().setPickBoundary(1)
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleUndo() })

    expect(useEditorState.getState().editingFeatureId).toBeNull()
    expect(useEditorState.getState().pickBoundary).toBeNull()
  })

  it('D02: the rollback mirror is skipped while a feature editor is open', () => {
    docRef.current = rollbackDoc()
    useEditorState.getState().setRollbackPosition(2)
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    useEditorState.getState().setEditingFeatureId('f1')
    act(() => { result.current.startEditSession(true) })
    // The bar moves transiently while the editor is open; the mirror must not
    // rewrite the doc position with it.
    useEditorState.getState().setRollbackPosition(3)
    act(() => { result.current.handleMutation(renameTo('in-edit')) })

    expect(docRef.current?.rollback).toBe(2)
  })

  it('D03: set_rollback dispatched without a pre-synced store fails loud', () => {
    docRef.current = rollbackDoc()
    useEditorState.getState().setRollbackPosition(null)
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    expect(() => {
      act(() => { result.current.handleMutation({ type: 'set_rollback', position: 2 }) })
    }).toThrow('set_rollback dispatched with the rollback store not pre-synced')
  })

  it('D04: a body-style mutation without a bodyId fails loud in test mode', () => {
    docRef.current = partStyleDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    expect(() => {
      act(() => {
        result.current.handleMutation({ type: 'set_part_color', color: '#00ff00' } as unknown as Mutation)
      })
    }).toThrow(/bodyId/)
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('D05: in prod the bodyless mutation still lands its entry and dirty flag', () => {
    failLoudMock.mockImplementation(() => {})
    const result = runPartTranscript(partStyleDoc(), [{
      kind: 'mutation',
      mutation: { type: 'set_part_color', color: '#00ff00' } as unknown as Mutation,
    }])

    expect(failLoudMock).toHaveBeenCalledTimes(1)
    expect(result.undoLabels).toHaveLength(1)
    expect(result.dirty).toBe(true)
    expect((result.doc?.part_style as Record<string, unknown> | undefined)?.['undefined']).toBeDefined()
  })

  it('D07: a raw append after an undo mirrors the restored store position, not the end', () => {
    // The mirror writes whatever position the store holds. Production append
    // paths pre-sync the store to the end (Part.tsx setRollbackForNewFeature),
    // but the hook alone does not: after an undo of the only feature the store
    // is parked at 0, and the next raw append bakes rollback: 0 into the doc
    // holding the new feature. Pinned as the current behaviour; the behaviour
    // table records the caller obligation as ambiguous.
    const result = runPartTranscript(makeDoc(), [
      { kind: 'mutation', mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Ext', sketchQuery: '@sk1', distance: 10 } },
      { kind: 'undo' },
      { kind: 'mutation', mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Ext', sketchQuery: '@sk1', distance: 10 } },
    ])

    expect(result.doc?.features).toHaveLength(1)
    expect(result.doc?.rollback).toBe(0)
    // The store itself never moved off the position the undo restored, which
    // is why the append mirrored 0 in the first place.
    expect(result.editorState.rollbackPosition).toBe(0)
  })

  it('D08: a mutation after a session boundary reads the cleaned-up editor state', () => {
    // The driver mirrors the page's exit cleanup, so a transcript that keeps
    // going after commit or cancel sees the store the app would: no editing id,
    // no pick boundary, and the bar re-derived from the doc.
    const withSession = (end: TranscriptStep): TranscriptResult => runPartTranscript(rollbackDoc(), [
      { kind: 'sessionStart', suppressed: true, featureId: 'f1' },
      { kind: 'mutation', mutation: { type: 'rename_feature', featureId: 'f1', label: 'in-session' } },
      end,
      { kind: 'mutation', mutation: { type: 'rename_feature', featureId: 'f1', label: 'after' } },
    ])

    const committed = withSession({ kind: 'sessionCommit' })
    expect(committed.editorState).toEqual({
      editingFeatureId: null,
      rollbackPosition: 2,
      pickBoundary: null,
    })
    expect(committed.undoLabels).toEqual(['edit f1', 'rename f1 to after'])

    const cancelled = withSession({ kind: 'sessionCancel' })
    // The cleanup runs before the cancel (production's reset-before-cancel), so
    // the rewind's own bar re-derivation is the last word on the position.
    expect(cancelled.editorState).toEqual({
      editingFeatureId: null,
      rollbackPosition: 2,
      pickBoundary: null,
    })
    expect(cancelled.doc?.rollback).toBe(2)
    expect(cancelled.undoLabels).toEqual(['rename f1 to after'])
  })

  it('D06: only the drag family bypasses the solve cache; the group funnel never does', () => {
    const dragDoc = pointSketchDoc()
    runPartTranscript(dragDoc, [{
      kind: 'mutation',
      mutation: {
        type: 'move_vertex', featureId: 'sk1', entityId: 'l1', vertexKey: 'start', to: [1, 1],
        solvedGeometry: { l1: [1, 1, 10, 0] },
      },
    }])
    const dragOpts = reSolve.mock.calls.at(-1)?.[1] as { bypassCache?: boolean; dragAnchor?: unknown }
    expect(dragOpts?.bypassCache).toBe(true)
    expect(dragOpts?.dragAnchor).toEqual({ featureId: 'sk1', entityId: 'l1' })

    runPartTranscript(extrudeDoc(), [{ kind: 'mutation', mutation: renameTo('a') }])
    const renameOpts = reSolve.mock.calls.at(-1)?.[1] as { bypassCache?: boolean } | undefined
    expect(renameOpts?.bypassCache).toBe(false)

    runPartTranscript(pointSketchDoc(), [{
      kind: 'group',
      mutations: [addPoint('pt1', [5, 5]), lengthConstraint('entity:sk1:pt1')],
    }])
    const groupOpts = reSolve.mock.calls.at(-1)?.[1] as { bypassCache?: boolean; _suppressFirstSolve?: boolean } | undefined
    expect(groupOpts?.bypassCache).toBeUndefined()
    expect(groupOpts?._suppressFirstSolve).toBe(true)
  })
})

// ─── Assembly engine rows (same promises, its own engine) ───

const assemblyDocWith = (featureIds: string[]): AssemblyDoc => ({
  kind: 'assembly',
  features: featureIds.map(id => ({
    id, kind: 'part_instance',
    instance: { handle: id, doc_id: `d-${id}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true },
  })),
})

describe('assembly engine rows', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    // The stacks live in the module-level History; clearing it is the only
    // reset that reaches them (setSnapshot preserves the store-owned mirror).
    useAssemblyStore.getState().clearAssemblyHistory()
    useAssemblyStore.setState({
      subject: null, activeMateField: null, mateFieldDirty: false,
      pickCandidates: [], pickIndex: -1,
      editingSubject: { kind: 'none' },
    })
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('A01: decideAssemblyMutation classes a no-op, a push and a fold', () => {
    const doc = assemblyDocWith(['a'])
    expect(decideAssemblyMutation({ pre: doc, next: doc, sessionOpen: false })).toBe('noop')
    expect(decideAssemblyMutation({ pre: doc, next: assemblyDocWith(['a']), sessionOpen: false })).toBe('noop')
    expect(decideAssemblyMutation({ pre: doc, next: assemblyDocWith(['a', 'b']), sessionOpen: false })).toBe('push')
    expect(decideAssemblyMutation({ pre: doc, next: assemblyDocWith(['a', 'b']), sessionOpen: true })).toBe('fold')
    expect(decideAssemblyMutation({ pre: null, next: doc, sessionOpen: true })).toBe('noop')
  })

  it('A02: the session pin is taken at the first session edit, and commit folds one entry', () => {
    const before = assemblyDocWith(['a'])
    const afterFirst = assemblyDocWith(['a', 'b'])
    const afterSecond = assemblyDocWith(['a', 'b', 'c'])
    const docRef = { current: before as AssemblyDoc | null }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    act(() => { useAssemblyStore.getState().openInstanceEditor('a') })
    act(() => {
      result.current.mutate('Set position', () => afterFirst)
      result.current.mutate('Set position', () => afterSecond)
    })
    // Both edits folded behind the session: nothing pushed yet.
    expect(result.current.undoStack).toHaveLength(0)

    act(() => { result.current.commitSession() })
    expect(result.current.undoStack).toHaveLength(1)
    // The pin is the FIRST pre-session doc, so undo returns all the way.
    expect(result.current.undoStack[0].doc).toEqual(before)

    act(() => { result.current.handleUndo() })
    expect(docRef.current).toEqual(before)
  })

  it('A03: an undo on an empty stack leaves the open editor open', () => {
    const docRef = { current: assemblyDocWith(['a']) as AssemblyDoc | null }
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, vi.fn(), vi.fn(),
    ))
    act(() => { useAssemblyStore.getState().openInstanceEditor('a') })

    act(() => { result.current.handleUndo() })

    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'instance', handle: 'a' })
    expect(result.current.undoStack).toHaveLength(0)
  })

  // The part engine's redo-mid-session row (T04) tears the editor down when the
  // commit that resolved the session cleared the redo branch (openWorkCommitted).
  // The assembly engine commits the session and returns at the empty-branch
  // guard WITHOUT closing the editor, so the same keystroke leaves it standing.
  // Pinned here as the current behaviour; the behaviour table records the
  // disagreement as ambiguous rather than fixing either engine.
  it('A04: a redo mid-session whose commit cleared the branch leaves the editor open', () => {
    const docA = assemblyDocWith(['a'])
    const docB = assemblyDocWith(['a', 'b'])
    const docC = assemblyDocWith(['a', 'c'])
    const docRef = { current: docB as AssemblyDoc | null }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(
      docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
    ))

    act(() => { result.current.pushUndo(docA, 'Add part') })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { useAssemblyStore.getState().openInstanceEditor('a') })
    act(() => { result.current.mutate('Set position', () => docC) })
    act(() => { result.current.handleRedo() })

    // The commit pushed and cleared the redo branch, so no move happened and
    // the editor is still open on 'a'; a later OK would push nothing.
    expect(result.current.undoStack.map(e => e.label)).toEqual(['Set position'])
    expect(result.current.redoStack).toHaveLength(0)
    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'instance', handle: 'a' })
  })
})
