// History properties over the mutation example registry: every registered
// mutation, run through the real hook composition, must round-trip through undo
// and redo, must obey the no-op guard's contract, must let a fresh edit clear
// the redo branch, must stay stable across repeated undo/redo, and must never
// exceed the history cap. Deep equality (toEqual) is the only comparison, so
// key order is not an accidental contract. A failure here is a finding to
// record, not production code to change.
import { describe, it, expect, vi } from 'vitest'
import { IDEMPOTENT_MUTATION } from '@/hooks/mutationIdempotence'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { MUTATION_EXAMPLES, type MutationExample } from './mutationExamples'
import { runPartTranscript, type TranscriptStep } from './historyTranscript'
import type { Mutation, PartDoc } from '@/types/cad'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

// set_rollback's doc write is the mirror reading the editor store, so a
// transcript must pre-sync the store through the rollback step rather than
// dispatch the raw mutation (which would trip the fail-loud guard).
const stepFor = (mutation: Mutation): TranscriptStep =>
  mutation.type === 'set_rollback'
    ? { kind: 'rollback', position: mutation.position as number }
    : { kind: 'mutation', mutation }

const save: TranscriptStep = { kind: 'save' }
const undo: TranscriptStep = { kind: 'undo' }
const redo: TranscriptStep = { kind: 'redo' }

const entries = Object.entries(MUTATION_EXAMPLES) as [Mutation['type'], MutationExample][]

describe.each(entries)('history properties: %s', (type, example) => {
  const pre = example.makeDoc()
  const step = stepFor(example.mutation)

  it('a forward apply lands, and undo/redo round-trip the doc deep-equal', () => {
    // One run only: several handlers mint random ids, so a redo can only be
    // compared against the forward doc it came from, never a sibling run's.
    const snapshots: (PartDoc | null)[] = []
    const result = runPartTranscript(pre, [step, undo, redo], {
      onStep: (doc) => { snapshots.push(doc) },
    })
    const [forward, undone, redone] = snapshots
    if (example.labelOnly) {
      // A label carrier writes nothing: the entry it pushes is the whole effect.
      expect(forward).toEqual(pre)
    } else {
      expect(forward).not.toEqual(pre)
    }
    expect(undone).toEqual(pre)
    expect(redone).toEqual(forward)

    expect(result.undoLabels).toHaveLength(1)
    expect(result.redoLabels).toHaveLength(0)
    // The pair holds exactly the one entry the sequence produced, so a push
    // that duplicated or lost an entry fails here. The cap itself is exercised
    // non-vacuously by the dedicated test below.
    expect(result.undoLabels.length + result.redoLabels.length).toBe(1)
  })

  it('a second dispatch obeys the no-op guard contract', () => {
    const afterFirst = runPartTranscript(pre, [step])
    const afterSecond = runPartTranscript(pre, [step, save, step])
    expect(afterFirst.undoLabels).toHaveLength(1)
    const added = afterSecond.undoLabels.length - afterFirst.undoLabels.length
    const guarded = IDEMPOTENT_MUTATION[type] === true || type === 'add_constraint' || type === 'delete'
    if (guarded) {
      // The slice compare (or the whole-doc compare for add_constraint and
      // delete) may swallow the second dispatch only when it left the doc
      // deep-equal; a real change must always land its entry. The branch is
      // taken from the entry count so the doc assertion is what catches a
      // swallowed change, never an assumption about which case applies.
      expect([0, 1]).toContain(added)
      if (added === 0) {
        expect(afterSecond.doc).toEqual(afterFirst.doc)
        expect(afterSecond.dirty).toBe(false)
      } else {
        expect(afterSecond.doc).not.toEqual(afterFirst.doc)
        expect(afterSecond.dirty).toBe(true)
      }
    } else {
      // Deliberately unguarded types land their entry even when the handler
      // leaves the doc deep-equal (move_*, the add_*/toggle toggles, the label
      // carriers): the dispatch was a real user action.
      expect(added).toBe(1)
      expect(afterSecond.dirty).toBe(true)
    }
  })

  it('a fresh edit after an undo clears the redo branch', () => {
    const fresh = runPartTranscript(pre, [step, undo, step])
    expect(fresh.redoLabels).toHaveLength(0)
    expect(fresh.undoLabels).toHaveLength(1)
    if (!example.labelOnly) expect(fresh.doc).not.toEqual(pre)
  })

  it('undo, redo and a repeated undo/redo cycle are stable', () => {
    const snapshots: (PartDoc | null)[] = []
    const swung = runPartTranscript(pre, [step, undo, redo, undo, redo], {
      onStep: (doc) => { snapshots.push(doc) },
    })
    // The forward doc and both redo landings are the same document, and every
    // undo landing is the pre doc, across two full cycles.
    expect(snapshots[2]).toEqual(snapshots[0])
    expect(snapshots[4]).toEqual(snapshots[0])
    expect(snapshots[1]).toEqual(pre)
    expect(snapshots[3]).toEqual(pre)
    expect(swung.undoLabels).toHaveLength(1)
    expect(swung.redoLabels).toHaveLength(0)
  })
})

describe('history cap', () => {
  it(`drops the oldest entries beyond ${MAX_UNDO_DEPTH} and conserves the pair`, () => {
    const pre = MUTATION_EXAMPLES.add_entity.makeDoc()
    const pushes: TranscriptStep[] = Array.from({ length: MAX_UNDO_DEPTH + 5 }, (_, i) => ({
      kind: 'mutation',
      mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [i, 0, i + 1, 1], entityId: `l${i}` },
    }))

    const pushed = runPartTranscript(pre, pushes)
    expect(pushed.undoLabels).toHaveLength(MAX_UNDO_DEPTH)
    expect(pushed.redoLabels).toHaveLength(0)

    // Undoing more times than the cap can absorb drains the stack and stops:
    // the five oldest pushes fell out of the history and cannot come back.
    const drained = runPartTranscript(pre, [...pushes, ...Array.from({ length: MAX_UNDO_DEPTH + 5 }, () => undo)])
    expect(drained.undoLabels).toHaveLength(0)
    expect(drained.redoLabels).toHaveLength(MAX_UNDO_DEPTH)
    expect(drained.undoLabels.length + drained.redoLabels.length).toBeLessThanOrEqual(MAX_UNDO_DEPTH)
  })
})
