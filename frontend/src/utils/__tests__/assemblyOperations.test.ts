import { describe, it, expect, vi } from 'vitest'
import {
  ASSEMBLY_OPERATIONS,
  planAssemblyOperation,
  runAssemblyOperation,
  type AssemblyOperationHost,
  type AssemblyOperationId,
  type AssemblyOperationInputs,
} from '@/utils/assemblyOperations'
import { findInstance, findMate } from '@/utils/assemblyMutations'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import type { AssemblyDoc } from '@/types/cad'

// The literal policy table from the plan. Every cell is pinned, so adding an
// operation with the wrong bake/undo/solve fails here rather than silently
// re-deriving the policy in the page.
const EXPECTED: Array<Pick<
  (typeof ASSEMBLY_OPERATIONS)[AssemblyOperationId],
  'id' | 'label' | 'bake' | 'undo' | 'solve'
>> = [
  { id: 'add_part', label: 'Add part', bake: true, undo: 'one-shot', solve: 'solve' },
  { id: 'duplicate_part', label: 'Duplicate part', bake: true, undo: 'one-shot', solve: 'solve' },
  { id: 'delete_part', label: 'Delete part', bake: true, undo: 'one-shot', solve: 'solve' },
  { id: 'set_part_visible', label: 'Toggle visibility', bake: false, undo: 'one-shot', solve: 'skip' },
  { id: 'set_builtin_visible', label: 'Toggle plane visibility', bake: false, undo: 'one-shot', solve: 'skip' },
  { id: 'set_part_fixed', label: 'Fix/unfix part', bake: true, undo: 'fold', solve: 'skip' },
  { id: 'set_part_fixed_oneshot', label: 'Fix/unfix part', bake: true, undo: 'one-shot', solve: 'skip' },
  { id: 'set_part_position', label: 'Set position', bake: true, undo: 'fold', solve: 'solve' },
  { id: 'set_part_rotation', label: 'Set rotation', bake: true, undo: 'fold', solve: 'solve' },
  { id: 'add_mate', label: 'Add mate', bake: false, undo: 'one-shot', solve: 'skip' },
  { id: 'delete_mate', label: 'Delete mate', bake: true, undo: 'one-shot', solve: 'solve' },
  { id: 'update_mate', label: 'Edit mate', bake: false, undo: 'fold', solve: 'defer' },
  { id: 'reorder_part', label: 'Reorder part', bake: false, undo: 'one-shot', solve: 'skip' },
  { id: 'reorder_mate', label: 'Reorder mate', bake: false, undo: 'one-shot', solve: 'skip' },
  { id: 'rename_mate', label: 'Rename mate', bake: false, undo: 'one-shot', solve: 'skip' },
]

function instanceFeature(handle: string, tx: number, fixed = false) {
  return {
    id: `fp-${handle}`,
    kind: 'part_instance' as const,
    instance: {
      handle, doc_id: `d-${handle}`, doc_rev: 1,
      transform: { ...IDENTITY_TRANSFORM, tx }, visible: true, fixed,
    },
  }
}

function docWithInstances(handles: string[]): AssemblyDoc {
  return { kind: 'assembly', features: handles.map(h => instanceFeature(h, 0)) }
}

// A rich doc that gives every table id a real change to make.
function operationDoc(): AssemblyDoc {
  return {
    kind: 'assembly',
    features: [
      { id: 'Origin', kind: 'origin' },
      instanceFeature('p1', 0),
      instanceFeature('p2', 0),
      { id: 'm1', kind: 'mate', mate: {
        kind: 'fixed', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'b1' },
      } },
      { id: 'm2', kind: 'mate', mate: {
        kind: 'spherical', ref_a: { part: 'p1', anchor: 'a2' }, ref_b: { part: 'p2', anchor: 'b2' },
      } },
    ],
  }
}

// The exact app-side signature of `runAssemblyOperation` is generic per id;
// the table test only needs one value per id.
const INPUTS: { [K in AssemblyOperationId]: AssemblyOperationInputs[K] } = {
  add_part: { docId: 'd-new', docRev: 3 },
  duplicate_part: 'p1',
  delete_part: 'p1',
  set_part_visible: { handle: 'p1', visible: false },
  set_builtin_visible: { id: 'Origin', visible: true },
  set_part_fixed: { handle: 'p1', fixed: true },
  set_part_fixed_oneshot: { handle: 'p1', fixed: true },
  set_part_position: { handle: 'p1', pos: { tx: 3, ty: 0, tz: 0 } },
  set_part_rotation: { handle: 'p1', euler: { rx: 90, ry: 0, rz: 0 } },
  add_mate: { kind: 'fixed', id: 'new-mate' },
  delete_mate: 'm1',
  update_mate: { id: 'm1', patch: { offset: 4 } },
  reorder_part: { movingHandle: 'p2', beforeHandle: 'p1' },
  reorder_mate: { movingId: 'm2', beforeId: 'm1' },
  rename_mate: { id: 'm1', label: 'Renamed' },
}

const IDS = Object.keys(ASSEMBLY_OPERATIONS) as AssemblyOperationId[]

describe('ASSEMBLY_OPERATIONS table', () => {
  it('pins every bake/undo/solve cell', () => {
    const actual = IDS.map(id => {
      const d = ASSEMBLY_OPERATIONS[id]
      return { id: d.id, label: d.label, bake: d.bake, undo: d.undo, solve: d.solve }
    })
    expect(actual).toEqual(EXPECTED)
  })

  it('every entry is schema-valid', () => {
    for (const def of Object.values(ASSEMBLY_OPERATIONS)) {
      expect(typeof def.id).toBe('string')
      expect(def.id.length).toBeGreaterThan(0)
      expect(typeof def.label).toBe('string')
      expect(def.label.length).toBeGreaterThan(0)
      expect(typeof def.bake).toBe('boolean')
      expect(['one-shot', 'fold']).toContain(def.undo)
      expect(['solve', 'defer', 'skip']).toContain(def.solve)
      expect(typeof def.apply).toBe('function')
    }
  })
})

describe('planAssemblyOperation', () => {
  it('returns null when there is no doc', () => {
    expect(planAssemblyOperation('add_part', INPUTS.add_part, { doc: null, transforms: {} })).toBeNull()
  })

  it('bakes the solved pose into the seed before add_part appends', () => {
    const pre = { kind: 'assembly' as const, features: [instanceFeature('p1', 0)] }
    const transforms = { p1: { ...IDENTITY_TRANSFORM, tx: 5 } }
    const plan = planAssemblyOperation('add_part', { docId: 'd2', docRev: 1 }, { doc: pre, transforms })!
    expect(plan.changed).toBe(true)
    expect(findInstance(plan.doc, 'p1')!.transform.tx).toBe(5)
  })

  it('does not bake for update_mate or set_part_visible', () => {
    const pre = { kind: 'assembly' as const, features: [
      instanceFeature('p1', 0),
      { id: 'm1', kind: 'mate' as const, mate: {
        kind: 'fixed' as const, ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p1', anchor: 'a2' },
      } },
    ] }
    const transforms = { p1: { ...IDENTITY_TRANSFORM, tx: 5 } }

    const matePlan = planAssemblyOperation('update_mate', INPUTS.update_mate, { doc: pre, transforms })!
    expect(findInstance(matePlan.doc, 'p1')!.transform.tx).toBe(0)
    expect(findMate(matePlan.doc, 'm1')!.offset).toBe(4)

    const visPlan = planAssemblyOperation('set_part_visible', INPUTS.set_part_visible, { doc: pre, transforms })!
    expect(findInstance(visPlan.doc, 'p1')!.transform.tx).toBe(0)
  })

  it('pins the solve cells that defer', () => {
    const doc = operationDoc()
    const ctx = { doc, transforms: {} }
    expect(planAssemblyOperation('update_mate', INPUTS.update_mate, ctx)!.solve).toBe('defer')
    expect(planAssemblyOperation('set_part_position', INPUTS.set_part_position, ctx)!.solve).toBe('solve')
    expect(planAssemblyOperation('set_part_visible', INPUTS.set_part_visible, ctx)!.solve).toBe('skip')
  })

  it('reports a value no-op as unchanged', () => {
    const doc = docWithInstances(['p1'])
    const plan = planAssemblyOperation('set_part_visible', { handle: 'p1', visible: true }, { doc, transforms: {} })!
    expect(plan.changed).toBe(false)
    expect(plan.doc).toEqual(doc)
  })
})

describe('runAssemblyOperation effect dispatch', () => {
  function fakeHost(): AssemblyOperationHost & {
    mutateSession: ReturnType<typeof vi.fn>
    mutateOneShot: ReturnType<typeof vi.fn>
    requestSolve: ReturnType<typeof vi.fn>
    requestSolveOrDefer: ReturnType<typeof vi.fn>
  } {
    return {
      doc: operationDoc(),
      transforms: {},
      mutateSession: vi.fn(),
      mutateOneShot: vi.fn(),
      requestSolve: vi.fn(),
      requestSolveOrDefer: vi.fn(),
    }
  }

  it('fires exactly the host effect each cell names', () => {
    for (const id of IDS) {
      const host = fakeHost()
      runAssemblyOperation(id, INPUTS[id] as never, host)
      const { undo, solve } = ASSEMBLY_OPERATIONS[id]
      if (undo === 'one-shot') {
        expect(host.mutateOneShot, `${id} should be one-shot`).toHaveBeenCalledTimes(1)
        expect(host.mutateSession, `${id} should not fold`).not.toHaveBeenCalled()
      } else {
        expect(host.mutateSession, `${id} should fold`).toHaveBeenCalledTimes(1)
        expect(host.mutateOneShot, `${id} should not be one-shot`).not.toHaveBeenCalled()
      }
      const solveCalls = solve === 'skip' ? 0 : 1
      expect(host.requestSolve, `${id} solve cell`).toHaveBeenCalledTimes(solve === 'solve' ? 1 : 0)
      expect(host.requestSolveOrDefer, `${id} solve cell`).toHaveBeenCalledTimes(solve === 'defer' ? 1 : 0)
      expect(host.requestSolve.mock.calls.length + host.requestSolveOrDefer.mock.calls.length).toBe(solveCalls)
    }
  })

  it('a value no-op touches no effect', () => {
    const host = fakeHost()
    host.doc = docWithInstances(['p1'])
    runAssemblyOperation('set_part_visible', { handle: 'p1', visible: true }, host)
    expect(host.mutateOneShot).not.toHaveBeenCalled()
    expect(host.mutateSession).not.toHaveBeenCalled()
    expect(host.requestSolve).not.toHaveBeenCalled()
    expect(host.requestSolveOrDefer).not.toHaveBeenCalled()
  })
})
