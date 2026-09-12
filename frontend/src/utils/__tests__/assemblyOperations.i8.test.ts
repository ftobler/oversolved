import { describe, it, expect, vi } from 'vitest'
import { planAssemblyOperation, runAssemblyOperation, type AssemblyOperationHost } from '@/utils/assemblyOperations'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import type { AssemblyDoc } from '@/types/cad'

// I8: add_part is the only site that authors an outward link, so it refuses when
// the named doc is not a live part entry in the open workspace. The guard lives
// in the operation layer, not in the pure mutation: appendPartInstance stays a
// pure assembly-local change.

function instanceFeature(handle: string) {
  return {
    id: `fp-${handle}`,
    kind: 'part_instance' as const,
    instance: {
      handle, doc_id: `d-${handle}`, doc_rev: 1,
      transform: { ...IDENTITY_TRANSFORM }, visible: true,
    },
  }
}

const doc: AssemblyDoc = { kind: 'assembly', features: [instanceFeature('p1')] }

describe('I8: add_part is refused at the mutation', () => {
  it('throws when docId is not in knownPartIds', () => {
    expect(() => planAssemblyOperation(
      'add_part',
      { docId: 'ghost', docRev: 1 },
      { doc, transforms: {}, knownPartIds: new Set(['part-1']) },
    )).toThrow(/not a live entry/)
  })

  it('appends when docId is a live part entry', () => {
    const plan = planAssemblyOperation(
      'add_part',
      { docId: 'part-1', docRev: 3 },
      { doc, transforms: {}, knownPartIds: new Set(['part-1']) },
    )
    expect(plan).not.toBeNull()
    expect(plan!.changed).toBe(true)
    const added = plan!.doc.features!.find(f => f.kind === 'part_instance' && f.instance?.doc_id === 'part-1')
    expect(added).toBeDefined()
  })

  it('skips the guard when no set is supplied (an unscoped caller)', () => {
    const plan = planAssemblyOperation('add_part', { docId: 'ghost', docRev: 1 }, { doc, transforms: {} })
    expect(plan?.changed).toBe(true)
  })

  it('duplicate_part copies an in-doc link and never needs the set', () => {
    expect(() => planAssemblyOperation(
      'duplicate_part',
      'p1',
      { doc, transforms: {}, knownPartIds: new Set() },
    )).not.toThrow()
    const plan = planAssemblyOperation('duplicate_part', 'p1', { doc, transforms: {}, knownPartIds: new Set() })
    expect(plan!.changed).toBe(true)
  })

  it('runAssemblyOperation refuses before touching a host effect', () => {
    const host: AssemblyOperationHost = {
      doc,
      transforms: {},
      knownPartIds: new Set(['part-1']),
      mutateSession: vi.fn(),
      mutateOneShot: vi.fn(),
      requestSolve: vi.fn(),
      requestSolveOrDefer: vi.fn(),
    }
    expect(() => runAssemblyOperation('add_part', { docId: 'ghost', docRev: 1 }, host)).toThrow(/not a live entry/)
    expect(host.mutateOneShot).not.toHaveBeenCalled()
    expect(host.requestSolve).not.toHaveBeenCalled()
  })
})
