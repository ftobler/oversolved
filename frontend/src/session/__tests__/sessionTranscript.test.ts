// @vitest-environment node
// The frozen session/history transcript table, driven through the headless
// session (sessionTranscript's driver) over the real mutation handlers. The
// step lists and checks are the same table the hook driver runs
// (usePartDoc.historyTranscript.test.ts); the rows here pin the L1 semantics,
// while the hook suite pins the React adapter over them. Deep equality only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import { runSessionTranscript, type SessionTranscriptHarness } from './sessionTranscript'
import type { TranscriptResult, TranscriptStep } from '@/hooks/__tests__/historyTranscript'

// The no-op guard's bodyId diagnostic is the one failLoud the session still
// reaches: mock it controllably so the dev row can throw and the prod row can
// land, exactly as the hook transcript suite does.
const { failLoudMock } = vi.hoisted(() => ({ failLoudMock: vi.fn() }))

vi.mock('@/utils/invariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/invariants')>()
  return { ...actual, failLoud: failLoudMock }
})

// ─── Fixtures and readers ───

const extrudeDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
})

const colorDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  part_style: { b1: { color: '#ff0000' } },
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
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
    { id: 'f2', kind: 'extrude' },
    { id: 'f3', kind: 'fillet' },
  ],
})

const staleRollbackDoc = (): PartDoc => ({ ...rollbackDoc(), rollback: 99 })

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

const renameTo = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'extrude-1', label })

interface TranscriptRow {
  id: string
  name: string
  makeDoc: () => PartDoc
  steps: TranscriptStep[]
  // The harness is the result plus the driver internals a few checks need
  // (the solve calls and the doc cell); the result half is TranscriptResult.
  check: (result: TranscriptResult, pre: PartDoc, harness: SessionTranscriptHarness) => void
}

const batches = (n: number): TranscriptStep[] => Array.from({ length: n }, (_, i) => ({
  kind: 'mutation' as const,
  mutation: addPoint(`p${i}`, [i, 0]),
}))

const ROWS: TranscriptRow[] = [
  // ─── history basics ───
  {
    id: 'H01',
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
    id: 'H04/H05',
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
    id: 'H02/H03',
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
    id: 'H08',
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
      // (the blocked move tears down), the edits stay reachable by a plain
      // undo, and the live doc is exactly the post-edit one.
      expect(labelOf(result.doc)).toBe('in-edit')
      expect(result.undoLabels).toEqual(['edit extrude-1'])
      expect(result.redoLabels).toEqual([])
      expect(result.editorState.editingFeatureId).toBeNull()
      expect(result.editorState.pickBoundary).toBeNull()
      expect(result.dirty).toBe(true)
    },
  },
  {
    id: 'H06/H07',
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
    id: 'H10',
    name: 'undo restores the rollback bar from the entry doc, clamped to its feature list',
    makeDoc: staleRollbackDoc,
    steps: [{ kind: 'mutation', mutation: { type: 'rename_feature', featureId: 'f1', label: 'edited' } }, { kind: 'undo' }],
    check: (result, pre) => {
      // The restored entry parks rollback 99 in a 3-feature list; the bar is
      // clamped, the immutable entry doc is not rewritten.
      expect(result.doc).toEqual(pre)
      expect(result.doc?.rollback).toBe(99)
      expect(result.editorState.rollbackPosition).toBe(3)
    },
  },
  {
    id: 'H11',
    name: 'undo re-solves the restored doc',
    makeDoc: extrudeDoc,
    steps: [{ kind: 'mutation', mutation: renameTo('a') }, { kind: 'undo' }],
    check: (_result, pre, harness) => {
      const restored = harness.solve.calls.at(-1)?.doc
      expect(restored).toEqual(pre)
    },
  },

  // ─── sketch snapshot slot ───
  {
    id: 'S01/S02',
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
    id: 'S03',
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
    id: 'S03',
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
    id: 'S05',
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
    id: 'S06',
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
    id: 'S04',
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
    id: 'P01/P02',
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
    id: 'P04',
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
    id: 'P05',
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
    id: 'P06',
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
    id: 'P07',
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
    id: 'P08',
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
    id: 'B01/B02',
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
    id: 'B03',
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
    id: 'B05',
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
    id: 'B06',
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
    id: 'B07',
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
    id: 'R01',
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
    id: 'R03',
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
    id: 'N01',
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
    id: 'N01',
    name: 'a same-value body-style write pushes nothing and stays clean',
    makeDoc: partStyleDoc,
    steps: [{ kind: 'mutation', mutation: setColor('#ff0000') }],
    check: (result) => {
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },
  {
    id: 'N04',
    name: 'a deliberately unguarded no-op still lands its entry',
    makeDoc: extrudeDoc,
    steps: [{ kind: 'mutation', mutation: { type: 'delete_feature', featureId: 'ghost' } }],
    check: (result, pre) => {
      expect(result.doc).toEqual(pre)
      expect(result.undoLabels).toEqual(['delete feature ghost'])
      expect(result.dirty).toBe(true)
    },
  },
  {
    id: 'N05',
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
    id: 'N03',
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
    id: 'N03',
    name: 'a delete naming an absent entity pushes nothing',
    makeDoc: pointSketchDoc,
    steps: [{ kind: 'mutation', mutation: { type: 'delete', targets: ['entity:sk1:ghost'] } }],
    check: (result) => {
      expect(result.undoLabels).toEqual([])
      expect(result.dirty).toBe(false)
    },
  },
  {
    id: 'N02',
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
    id: 'G01',
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
    id: 'G02',
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
    id: 'D01',
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
    id: 'D02',
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
    id: 'D03',
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
    id: 'D05',
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
    const harness = runSessionTranscript(pre, steps)
    check(harness, pre, harness)
  })
})

// ─── Rows needing a seam the transcript union does not model ───

describe('teardown, guard and solve-option rows', () => {
  beforeEach(() => {
    failLoudMock.mockReset()
    failLoudMock.mockImplementation((message: string) => { throw new Error(message) })
  })

  it('D01 (seam): an undo that moves tears down the pick boundary along with the editing id', () => {
    const harness = runSessionTranscript(extrudeDoc(), [
      { kind: 'mutation', mutation: renameTo('a') },
    ])
    harness.editorFacts.editingFeatureId = 'extrude-1'
    harness.editorFacts.pickBoundary = 1

    harness.session.undo()

    expect(harness.editorState.editingFeatureId).toBeNull()
    expect(harness.editorState.pickBoundary).toBeNull()
  })

  it('D02 (seam): the rollback mirror is skipped while a feature editor is open', () => {
    const harness = runSessionTranscript(rollbackDoc(), [])
    harness.editorFacts.editingFeatureId = 'f1'
    harness.session.begin('edit', { suppressed: true })
    harness.editorFacts.rollbackPosition = 3
    harness.session.execute({ type: 'rename_feature', featureId: 'f1', label: 'in-edit' })

    expect(harness.docCell.current?.rollback).toBe(2)
  })

  it('D03 (seam): set_rollback without a pre-synced store is refused with the guard code', () => {
    const harness = runSessionTranscript(rollbackDoc(), [])
    harness.editorFacts.rollbackPosition = null

    expect(harness.session.execute({ type: 'set_rollback', position: 2 })).toEqual({
      ok: false, code: 'rollback-unsynced', message: expect.stringContaining('not pre-synced'),
    })
    expect(harness.undoLabels).toEqual([])
  })

  it('N06 (seam): a body-style mutation without a bodyId fails loud in test mode', () => {
    const harness = runSessionTranscript(partStyleDoc(), [])

    expect(() => {
      harness.session.execute({ type: 'set_part_color', color: '#00ff00' } as unknown as Mutation)
    }).toThrow(/bodyId/)
    expect(harness.session.historyEntries().undo).toHaveLength(0)
  })

  it('N07 (seam): in prod the bodyless mutation still lands its entry and dirty flag', () => {
    failLoudMock.mockImplementation(() => {})
    const harness = runSessionTranscript(partStyleDoc(), [{
      kind: 'mutation',
      mutation: { type: 'set_part_color', color: '#00ff00' } as unknown as Mutation,
    }])

    expect(failLoudMock).toHaveBeenCalledTimes(1)
    expect(harness.session.historyEntries().undo).toHaveLength(1)
    expect(harness.dirtyFacts.dirty).toBe(true)
    expect((harness.doc?.part_style as Record<string, unknown> | undefined)?.['undefined']).toBeDefined()
  })

  it('D07 (seam): a raw append after an undo mirrors the restored store position, not the end', () => {
    // Pinned as the current behaviour; the behaviour table records the caller
    // obligation as ambiguous.
    const harness = runSessionTranscript(makeDoc(), [
      { kind: 'mutation', mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Ext', sketchQuery: '@sk1', distance: 10 } },
      { kind: 'undo' },
      { kind: 'mutation', mutation: { type: 'add_extrude', featureId: 'ex1', label: 'Ext', sketchQuery: '@sk1', distance: 10 } },
    ])

    expect(harness.doc?.features).toHaveLength(1)
    expect(harness.doc?.rollback).toBe(0)
    expect(harness.editorState.rollbackPosition).toBe(0)
  })

  it('D08 (seam): a mutation after a session boundary reads the cleaned-up editor state', () => {
    const withSession = (end: TranscriptStep): SessionTranscriptHarness => runSessionTranscript(rollbackDoc(), [
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
    expect(cancelled.editorState).toEqual({
      editingFeatureId: null,
      rollbackPosition: 2,
      pickBoundary: null,
    })
    expect(cancelled.doc?.rollback).toBe(2)
    expect(cancelled.undoLabels).toEqual(['rename f1 to after'])
  })

  it('G04 (seam): only the drag family bypasses the solve cache; the group funnel never does', () => {
    const drag = runSessionTranscript(pointSketchDoc(), [{
      kind: 'mutation',
      mutation: {
        type: 'move_vertex', featureId: 'sk1', entityId: 'l1', vertexKey: 'start', to: [1, 1],
        solvedGeometry: { l1: [1, 1, 10, 0] },
      },
    }])
    const dragOpts = drag.solve.calls.at(-1)?.opts as { bypassCache?: boolean; dragAnchor?: unknown }
    expect(dragOpts?.bypassCache).toBe(true)
    expect(dragOpts?.dragAnchor).toEqual({ featureId: 'sk1', entityId: 'l1' })

    const rename = runSessionTranscript(extrudeDoc(), [{ kind: 'mutation', mutation: renameTo('a') }])
    expect((rename.solve.calls.at(-1)?.opts as { bypassCache?: boolean })?.bypassCache).toBe(false)

    const group = runSessionTranscript(pointSketchDoc(), [{
      kind: 'group',
      mutations: [addPoint('pt1', [5, 5]), lengthConstraint('entity:sk1:pt1')],
    }])
    const groupOpts = group.solve.calls.at(-1)?.opts as { bypassCache?: boolean; _suppressFirstSolve?: boolean }
    expect(groupOpts?.bypassCache).toBeUndefined()
    expect(groupOpts?._suppressFirstSolve).toBe(true)
  })

  it('H11 (seam): the retained pre-delete snapshot reaches the undo re-solve', () => {
    const harness = runSessionTranscript(filletDoc(), [])
    const snapshot: SketchData = { solved: {}, projection_errors: ['x'] }
    // Seed the solve-result port, delete the feature so the stash retains its
    // snapshot, then undo: the re-solve must be handed the snapshot back.
    harness.solveResults.current = { f1: snapshot }
    harness.session.execute({ type: 'delete_feature', featureId: 'f1' })

    harness.session.undo()

    expect(harness.doc?.features).toHaveLength(1)
    expect(harness.solve.calls.at(-1)?.opts?._restoreSolveResults).toEqual({ f1: snapshot })
  })
})
