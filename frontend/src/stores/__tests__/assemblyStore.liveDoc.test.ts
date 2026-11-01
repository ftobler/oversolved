// The store's own handlers (a mate ref pick, a delete) plan against the doc
// mirror React publishes, which lags the live doc within one handler. Each
// operation must apply against the live doc the mutation funnel hands it, or
// the second operation in the same handler starts from a doc that never saw the
// first and silently discards it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import {
  useAssemblyStore, setAssemblyCallbacks, DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
import { findMate } from '@/utils/assemblyMutations'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

function instance(handle: string) {
  return {
    id: `fp-${handle}`,
    kind: 'part_instance' as const,
    instance: { handle, doc_id: `d-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true },
  }
}

function mateDoc(): AssemblyDoc {
  return {
    kind: 'assembly',
    features: [
      instance('p1'),
      instance('p2'),
      instance('p3'),
      {
        id: 'm1',
        kind: 'mate',
        mate: {
          kind: 'fixed',
          ref_a: { part: 'p1', anchor: 'a1' },
          ref_b: { part: 'p2', anchor: 'b1' },
        },
      },
    ],
  }
}

describe('store-side assembly operations apply against the live doc', () => {
  let mirror: AssemblyDoc
  let live: AssemblyDoc
  let undoStack: AssemblyDoc[]

  beforeEach(() => {
    mirror = mateDoc()
    live = mirror
    undoStack = []
    // The page's funnel: every apply runs on the LIVE doc and records the
    // pre-op doc, exactly as useAssemblyUndoRedo.mutate does.
    const mutate = (_label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
      undoStack.push(live)
      live = fn(live)
    }
    setAssemblyCallbacks({ mutateDoc: mutate, mutateDocSession: mutate, requestSolve: () => {} })
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: mirror })
    // The mirror is what the store keeps answering; nothing republishes it
    // between the two calls below, which is the whole point.
    useAssemblyStore.setState({ doc: mirror, pickCandidates: [], pickIndex: -1 })
  })

  afterEach(() => {
    setAssemblyCallbacks(null)
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  })

  it('composes two ref picks in one handler and undoes only the second', () => {
    const store = useAssemblyStore.getState()

    store.setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    useAssemblyStore.setState({ pickCandidates: [{ part: 'p3', anchor: 'c1' }], pickIndex: 0 })
    store.commitAimToMateField()

    store.setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    useAssemblyStore.setState({ pickCandidates: [{ part: 'p3', anchor: 'c2' }], pickIndex: 0 })
    store.commitAimToMateField()

    // Both picks survived even though the mirror still names p1/p2.
    const mate = findMate(live, 'm1')
    expect(mate?.ref_a).toEqual({ part: 'p3', anchor: 'c1' })
    expect(mate?.ref_b).toEqual({ part: 'p3', anchor: 'c2' })
    expect(useAssemblyStore.getState().doc).toBe(mirror)

    // Undoing the second pick restores the doc the first one produced.
    expect(undoStack).toHaveLength(2)
    live = undoStack[undoStack.length - 1]
    const reopened = findMate(live, 'm1')
    expect(reopened?.ref_a).toEqual({ part: 'p3', anchor: 'c1' })
    expect(reopened?.ref_b).toEqual({ part: 'p2', anchor: 'b1' })
  })
})
