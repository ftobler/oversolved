// Stage 8 in the store: an armed mate chip turns the Stage 7 candidate set into
// a written MateRef. No viewport, no ID buffer, no document store: the hits are
// synthetic and the host callbacks are spies.
//
// The load-bearing rule under test is that committing a pick does NOT re-solve.
// A solve drops `pickCandidates` (a rebuilt bundle can retire the aimed anchor),
// so a solve per pick would make the second Ctrl+click on a corner re-aim the
// vertex instead of advancing to the edge behind it. The solve is owed until the
// field closes.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, setAssemblyCallbacks } from '@/stores/assemblyStore'
import type { AssemblySolveResult } from '@/stores/assemblyStore'
import { assemblyEntityKey, type EntityMateRefs } from '@/utils/anchorCandidates'
import type { AnchorTable } from '@/utils/anchorGizmos'
import { appendMate, findMate } from '@/utils/assemblyMutations'
import { runAssemblyOperation } from '@/utils/assemblyOperations'
import { instanceLabel } from '@/utils/instanceLabel'
import { mateRefLabel } from '@/utils/mateKinds'
import { IDENTITY_TRANSFORM, quatFromEulerXyz } from '@/utils/transform3d'

const PART = 'h1'
const VERT = assemblyEntityKey(PART, 0, 'vertex', 0)
const EDGE = assemblyEntityKey(PART, 0, 'edge', 0)
const FACE_B = assemblyEntityKey('h2', 0, 'face', 0)
const FACE_A = assemblyEntityKey(PART, 0, 'face', 1)
// Two instances of one part document offer the same deterministic anchor id:
// the hash is minted from the part geometry, not from the placement. This is
// the exact case that made both chips read alike in the report.
const FACE_TWIN = assemblyEntityKey('h2', 0, 'face', 1)
const SHARED_ANCHOR = 'a_shared'
const FREEFORM = assemblyEntityKey(PART, 0, 'face', 9)

const ENTITY_MATE_REFS: EntityMateRefs = {
  [VERT]: [{ part: PART, anchor: 'a_v' }],
  [EDGE]: [{ part: PART, anchor: 'a_e' }],
  [FACE_B]: [{ part: 'h2', anchor: 'b_f' }],
  [FACE_A]: [{ part: PART, anchor: SHARED_ANCHOR, anchor_descriptor: {
    geom_hash: '@u|face-a', kind: 'plane', created_by: 'box', point: [0, 0, 0],
  } }],
  [FACE_TWIN]: [{ part: 'h2', anchor: SHARED_ANCHOR, anchor_descriptor: {
    geom_hash: '@u|face-a', kind: 'plane', created_by: 'box', point: [0, 0, 0],
  } }],
  [FREEFORM]: [],
}

function instance(handle: string, docId: string): PartInstance {
  return {
    handle,
    doc_id: docId,
    doc_rev: 0,
    transform: { ...IDENTITY_TRANSFORM },
    visible: true,
  }
}

const SOLVE_RESULT: AssemblySolveResult = {
  transforms: {}, parts: {}, edgeCurves: {}, entityMateRefs: ENTITY_MATE_REFS, anchors: {},
  pickGeometry: [], solveStatus: null,
}

/** Resolver order at a corner: the vertex wins, the edge sits behind it. */
const CORNER_HITS = [{ entityKey: VERT }, { entityKey: EDGE }]

const { getState } = useAssemblyStore

const requestSolve = vi.fn()

/** Stands in for the AssemblyEditor: applies the mutation and re-syncs the store. */
function mutateDoc(_label: string, fn: (doc: AssemblyDoc) => AssemblyDoc): void {
  const next = fn(getState().doc!)
  getState().setSnapshot({ ...getState(), doc: next })
}

function currentMate(id: string) {
  return findMate(getState().doc!, id)!
}

beforeEach(() => {
  vi.clearAllMocks()
  getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  getState().setActiveMateField(null)
  getState().selectMate(null)
  getState().clearPickCandidates()
  getState().setPickScopeEntity(null)
  getState().setSolveResult(SOLVE_RESULT)
  setAssemblyCallbacks({ mutateDoc, mutateDocSession: mutateDoc, requestSolve })
  const doc = appendMate({ kind: 'assembly', features: [] }, 'fixed', 'm1')
  getState().setSnapshot({ ...getState(), doc })
  vi.clearAllMocks()
})

describe('arming a mate reference slot', () => {
  it('nothing is armed by default, so a pick only aims', () => {
    expect(getState().activeMateField).toBeNull()
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(getState().activePickCandidate()).toEqual({ part: PART, anchor: 'a_v' })
    expect(currentMate('m1').ref_a).toEqual({ part: '', anchor: '' })
  })

  it('an armed slot takes the aimed reference on the next pick', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_v' })
    expect(currentMate('m1').ref_b).toEqual({ part: '', anchor: '' })
  })

  it('picking does not re-solve, or the candidate set would be dropped mid-cycle', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(requestSolve).not.toHaveBeenCalled()
    expect(getState().pickCandidates).toHaveLength(2)
  })

  it('clicking the same corner again advances the cycle and rewrites the armed slot', () => {
    // The first pick fills A and hands the aim to B. Re-arming A is how the
    // user cycles the corner behind ref_a rather than re-aiming the new slot.
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_e' })
  })

  it('a pick on an anchor-less entity writes nothing', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: FREEFORM }])
    expect(currentMate('m1').ref_a).toEqual({ part: '', anchor: '' })
    expect(getState().mateFieldDirty).toBe(false)
  })

  it('picks across parts fill both slots', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_B }])
    const mate = currentMate('m1')
    expect(mate.ref_a).toEqual({ part: PART, anchor: 'a_v' })
    expect(mate.ref_b).toEqual({ part: 'h2', anchor: 'b_f' })
  })

  it('re-arming the other slot does not settle the owed solve yet', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    expect(requestSolve).not.toHaveBeenCalled()
    expect(getState().mateFieldDirty).toBe(true)
  })

  it('the Ctrl+hover scope narrows what an armed slot can take', () => {
    getState().setHoverHits([{ entityKey: EDGE }], true)
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_e' })
  })

  it('arming ref_b and picking a candidate on the part already in ref_a leaves the document unchanged', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])  // ref_a -> PART
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    const before = getState().doc
    getState().pickFromHitsOrCycle([{ entityKey: EDGE }])  // also on PART: refused
    const mate = currentMate('m1')
    expect(mate.ref_a).toEqual({ part: PART, anchor: 'a_v' })
    expect(mate.ref_b).toEqual({ part: '', anchor: '' })
    expect(getState().doc).toBe(before)
  })
})

// The report: two chips looked identical although the user picked different
// objects. The write path is correct; an anchor id is derived from the part
// document, so two placements of one part offer the same id, and the old label
// used the document name for both. The refs must differ and so must the labels.
describe('distinct picks read distinctly', () => {
  it('two instances of one document write different parts and show different labels', () => {
    const twins = [instance('h1', 'doc-x'), instance('h2', 'doc-x')]
    const names = { 'doc-x': 'Bracket' }
    const labelFor = (handle: string) => instanceLabel(twins, names, handle)
    const kindOf = () => 'plane'

    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_A }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_TWIN }])

    const mate = currentMate('m1')
    expect(mate.ref_a.part).not.toBe(mate.ref_b.part)
    expect(mate.ref_a.anchor).toBe(mate.ref_b.anchor)  // same geometry, different placement
    const labelA = mateRefLabel(mate.ref_a, labelFor, kindOf)
    const labelB = mateRefLabel(mate.ref_b, labelFor, kindOf)
    expect(labelA).toBe('Face of Bracket')
    expect(labelB).toBe('Face of Bracket (2)')
    expect(labelA).not.toBe(labelB)
  })

  it('two different documents also write and read as two references for fixed', () => {
    const parts = [instance('h1', 'doc-a'), instance('h2', 'doc-b')]
    const names = { 'doc-a': 'Alpha', 'doc-b': 'Beta' }
    const labelFor = (handle: string) => instanceLabel(parts, names, handle)
    const kindOf = () => 'plane'

    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_A }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_TWIN }])

    const mate = currentMate('m1')
    expect(mate.ref_a.part).not.toBe(mate.ref_b.part)
    expect(mateRefLabel(mate.ref_a, labelFor, kindOf)).toBe('Face of Alpha')
    expect(mateRefLabel(mate.ref_b, labelFor, kindOf)).toBe('Face of Beta')
  })
})

// The natural "click one object, click the other" gesture: a pick into an
// empty slot while the sibling is empty also hands the aim to that sibling.
// A pick into a filled slot still re-aims/cycles the slot the user armed.
describe('auto-advance after a pick', () => {
  it('a pick into an empty pair arms the other slot', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_v' })
    expect(getState().activeMateField).toEqual({ featureId: 'm1', field: 'ref_b' })
  })

  it('a pick into a filled slot keeps that slot armed', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)  // same corner cycles to the edge behind the vertex
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_e' })
    expect(getState().activeMateField).toEqual({ featureId: 'm1', field: 'ref_a' })
  })

  it('a refused same-part pick does not advance and writes nothing', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    const before = getState().doc
    getState().pickFromHitsOrCycle([{ entityKey: EDGE }])  // EDGE is on PART, already in ref_a
    expect(getState().doc).toBe(before)
    expect(getState().activeMateField).toEqual({ featureId: 'm1', field: 'ref_b' })
  })

  it('removing a filled ref arms that slot for the next pick', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])  // A: h1
    getState().pickFromHitsOrCycle([{ entityKey: FACE_B }])  // B: h2
    expect(currentMate('m1').ref_b).toEqual({ part: 'h2', anchor: 'b_f' })

    // The page runs the clear operation and then arms the slot, exactly as the
    // chip's Remove button does.
    runAssemblyOperation('clear_mate_ref', { id: 'm1', field: 'ref_b' }, {
      doc: getState().doc,
      transforms: getState().settledPoses(),
      mutateSession: mutateDoc,
      mutateOneShot: mutateDoc,
      requestSolve,
      requestSolveOrDefer: () => getState().requestSolveOrDefer(),
    })
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_v' })
    expect(currentMate('m1').ref_b).toEqual({ part: '', anchor: '' })
    expect(getState().activeMateField).toEqual({ featureId: 'm1', field: 'ref_b' })

    getState().pickFromHitsOrCycle([{ entityKey: FACE_TWIN }])  // a different h2 pick
    const mate = currentMate('m1')
    expect(mate.ref_b.part).toBe('h2')
    expect(mate.ref_b.anchor).toBe(SHARED_ANCHOR)
    expect(mate.ref_b.anchor_descriptor).toBeDefined()
  })
})

describe('closing a mate field', () => {
  it('disarming after a pick asks for exactly one solve', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().setActiveMateField(null)
    expect(requestSolve).toHaveBeenCalledTimes(1)
    expect(getState().mateFieldDirty).toBe(false)
  })

  it('disarming without a pick asks for no solve', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().setActiveMateField(null)
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('disarming twice does not solve twice', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().setActiveMateField(null)
    getState().setActiveMateField(null)
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('leaving the mate settles the solve its picks owe', () => {
    getState().selectMate('m1')
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().selectMate(null)
    expect(requestSolve).toHaveBeenCalledTimes(1)
    expect(getState().activeMateField).toBeNull()
  })

  it('selecting another mate disarms the previous one', () => {
    getState().selectMate('m1')
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().selectMate('m2')
    expect(getState().activeMateField).toBeNull()
    expect(getState().subject).toEqual({ kind: 'mate', id: 'm2' })
  })
})

// Closing the editor is one of the ways to leave a mate, and it used to skip
// the disarm: an armed chip stayed armed, the param edit it was holding stayed
// owed, and no solve ever landed. Opening another editor (the instance pencil,
// a mate insert) goes through this exact close, so it was the reported
// "the assembly edited but never re-solved".
describe('closing the editor settles the owed solve', () => {
  it('closing after a deferred edit requests one solve and disarms the field', () => {
    getState().openMateEditor('m1')
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().requestSolveOrDefer()
    expect(getState().mateFieldDirty).toBe(true)
    expect(requestSolve).not.toHaveBeenCalled()

    getState().closeEditor()

    expect(requestSolve).toHaveBeenCalledTimes(1)
    expect(getState().activeMateField).toBeNull()
    expect(getState().mateFieldDirty).toBe(false)
    expect(getState().editingSubject).toEqual({ kind: 'none' })
  })

  it('closing an editor with nothing owed asks for no solve', () => {
    getState().openMateEditor('m1')
    getState().closeEditor()
    expect(requestSolve).not.toHaveBeenCalled()
    expect(getState().activeMateField).toBeNull()
  })

  it('a full solve request settles the owed flag, so the later disarm is silent', () => {
    // Any full solve reads the doc the deferred edit already landed in, so it
    // pays the debt: the disarm that follows must not request a second solve.
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().requestSolveOrDefer()
    expect(getState().mateFieldDirty).toBe(true)

    // A delete's solve cell requests a full solve while the field is armed.
    getState().deleteSubject({ kind: 'mate', id: 'm1' })
    expect(requestSolve).toHaveBeenCalledTimes(1)
    expect(getState().mateFieldDirty).toBe(false)

    getState().setActiveMateField(null)
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })
})

// Completing a mate's reference pair captures the on-screen pose into its
// authored params (utils/mateCapture.ts): flip/angle, and for a fixed weld the
// translation as its offset in A's frame. The pose the user picked at is what
// the solver holds, as document data. Without the capture the solver would have
// to derive orientation from its seed -- the drift/ratchet/flip bug family this
// replaces.
describe('pose capture on pick', () => {
  const CAPTURE_ANCHORS: AnchorTable = {
    [PART]: {
      a_v: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], x_axis: [0, 1, 0] },
      a_e: { kind: 'line', point: [0, 0, 0], axis: [0, 0, -1], x_axis: [0, 1, 0] },
    },
    h2: {
      b_f: { kind: 'plane', point: [0, 0, 5], axis: [0, 0, -1], x_axis: [0, -1, 0] },
    },
  }

  it('completing the pair freezes the seen pose into flip and angle', () => {
    getState().setSolveResult({ ...SOLVE_RESULT, anchors: CAPTURE_ANCHORS })
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    // Half a pair captures nothing yet.
    expect('flip' in currentMate('m1')).toBe(false)
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_B }])
    // a_v (+Z, +Y frame) against b_f (-Z, -Y frame): a face-to-face pose.
    expect(currentMate('m1').flip).toBe(true)
    expect(currentMate('m1').angle).toBe(180)
  })

  it('freezes a fixed weld\'s translation as an offset in A\'s frame', () => {
    // A is a quarter turn about Z, so the world delta (0, 40, 0) is (40, 0, 0)
    // in A's frame; a world-delta implementation would store (0, 40, 0).
    const [qx, qy, qz, qw] = quatFromEulerXyz([0, 0, Math.PI / 2])
    const anchors: AnchorTable = {
      [PART]: { a_v: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], x_axis: [0, 1, 0] } },
      h2: { b_f: { kind: 'plane', point: [0, 40, 0], axis: [0, 0, 1], x_axis: [1, 0, 0] } },
    }
    getState().setSolveResult({
      ...SOLVE_RESULT,
      anchors,
      transforms: {
        [PART]: { tx: 0, ty: 0, tz: 0, qx, qy, qz, qw },
        h2: IDENTITY_TRANSFORM,
      },
    })
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_B }])
    expect(currentMate('m1').offset).toEqual({ x: 40, y: 0, z: 0 })
  })

  it('leaves the offset alone when the fixed pair has no solved pose to measure', () => {
    // SOLVE_RESULT carries no transforms, so the capture cannot carry the
    // translation into A's frame; it must not guess a world delta.
    getState().setSolveResult({ ...SOLVE_RESULT, anchors: CAPTURE_ANCHORS })
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_B }])
    expect(currentMate('m1')).not.toHaveProperty('offset')
  })

  it('cycling to a different anchor re-captures against the new geometry', () => {
    getState().setSolveResult({ ...SOLVE_RESULT, anchors: CAPTURE_ANCHORS })
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_B }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)  // aims a_v: opposed to b_f
    expect(currentMate('m1').flip).toBe(true)
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)  // cycles to a_e: same side as b_f
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_e' })
    expect('flip' in currentMate('m1')).toBe(false)
  })

  it('writes the refs but no orientation when the anchor table cannot resolve them', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_B }])
    const mate = currentMate('m1')
    expect(mate.ref_b).toEqual({ part: 'h2', anchor: 'b_f' })
    expect('flip' in mate).toBe(false)
    expect('angle' in mate).toBe(false)
  })

  // The aim commit is one set_mate_ref operation through the host funnel, the
  // same cell the drive runs: ref and captured orientation land in one undo step
  // (D9), so the shared write cannot drift from the headless one.
  it('commits the ref and the captured orientation as one set_mate_ref step', () => {
    const mutateSession = vi.fn(mutateDoc)
    setAssemblyCallbacks({ mutateDoc, mutateDocSession: mutateSession, requestSolve })
    getState().setSolveResult({ ...SOLVE_RESULT, anchors: CAPTURE_ANCHORS })
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    mutateSession.mockClear()
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_B }])

    expect(mutateSession).toHaveBeenCalledTimes(1)
    expect(mutateSession.mock.calls[0][0]).toBe('Pick mate reference')
    const apply = mutateSession.mock.calls[0][1] as (doc: AssemblyDoc) => AssemblyDoc
    const written = findMate(apply(getState().doc!), 'm1')!
    expect(written.ref_b).toEqual({ part: 'h2', anchor: 'b_f' })
    expect(written.flip).toBe(true)
    expect(written.angle).toBe(180)
  })

  it('a same-part pick never reaches the funnel', () => {
    const mutateSession = vi.fn(mutateDoc)
    setAssemblyCallbacks({ mutateDoc, mutateDocSession: mutateSession, requestSolve })
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    mutateSession.mockClear()
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: EDGE }])
    expect(mutateSession).not.toHaveBeenCalled()
  })
})

// A parameter edit is a document change like a pick, and it has to take the same
// deferral. Solving mid-authoring drops `pickCandidates`, and the still-armed
// field could no longer cycle the corner it aims at.
describe('requestSolveOrDefer', () => {
  it('solves straight away when no chip is armed', () => {
    getState().requestSolveOrDefer()
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('defers while a chip is armed, and the disarm settles it once', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().requestSolveOrDefer()
    expect(requestSolve).not.toHaveBeenCalled()
    expect(getState().mateFieldDirty).toBe(true)

    getState().setActiveMateField(null)
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('a deferred edit does not disturb the candidate set the armed field cycles', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().requestSolveOrDefer()
    expect(getState().pickCandidates).toHaveLength(2)
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_e' })
  })
})

describe('mate results', () => {
  it('a solve publishes the per-mate stale flags', () => {
    getState().setSolveResult({
      ...SOLVE_RESULT,
      solveStatus: {
        verdict: 'none', residualNorm: 0, rank: 0, dof: 0, iters: 0,
        mates: { m1: { stale: true, staleRefs: ['ref_b'] } }, parts: {},
      },
    })
    expect(getState().solveStatus!.mates.m1.stale).toBe(true)
    expect(getState().solveStatus!.mates.m1.staleRefs).toEqual(['ref_b'])
  })

  // The mate and its dead reference are retained: fail-safe over fail-wrong. The
  // solve never rewrites a ref, so the red row still names what the user picked.
  it('a stale result does not clear the reference it flagged', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    getState().setSolveResult({
      ...SOLVE_RESULT,
      solveStatus: {
        verdict: 'none', residualNorm: 0, rank: 0, dof: 0, iters: 0,
        mates: { m1: { stale: true, staleRefs: ['ref_a'] } }, parts: {},
      },
    })
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_v' })
  })

  it('setSnapshot leaves the authoring state alone (it is store-owned)', () => {
    getState().selectMate('m1')
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, entityMateRefs: ENTITY_MATE_REFS })
    expect(getState().subject).toEqual({ kind: 'mate', id: 'm1' })
    expect(getState().activeMateField).toEqual({ featureId: 'm1', field: 'ref_b' })
  })
})
