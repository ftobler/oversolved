// @vitest-environment node
// The assembly History owns a module-level singleton built at import time, so a
// receiver-checking structuredClone has to be installed BEFORE the module is
// loaded. Node's structuredClone ignores its receiver; this stands in for the
// Chrome throw the user saw on every assembly undo push.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'

const realStructuredClone = globalThis.structuredClone

function installReceiverCheckingClone(): void {
  globalThis.structuredClone = function (this: unknown, value: unknown, options?: StructuredSerializeOptions) {
    // A WebIDL operation rejects any receiver but the global (or undefined).
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
    return realStructuredClone(value, options)
  } as typeof structuredClone
}

async function freshAssemblyHistory() {
  vi.resetModules()
  installReceiverCheckingClone()
  const { assemblyHistory } = await import('@/stores/assemblyHistory')
  return assemblyHistory
}

afterEach(() => {
  globalThis.structuredClone = realStructuredClone
  vi.resetModules()
})

const docA: AssemblyDoc = { kind: 'assembly', features: [] }
const docB: AssemblyDoc = {
  kind: 'assembly',
  features: [{
    id: 'inst-1',
    kind: 'part_instance',
    instance: {
      handle: 'inst-1',
      doc_id: 'part-1',
      doc_rev: 1,
      transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      visible: true,
    },
  }],
}

describe('assemblyHistory clone receiver', () => {
  it('pushes and round-trips undo/redo with a receiver-checking structuredClone', async () => {
    const history = await freshAssemblyHistory()

    history.push('Add part', docA)
    history.push('Edit mate', docB)

    expect(history.undoLabels()).toEqual(['Add part', 'Edit mate'])
    expect(history.undo(docB)?.doc).toEqual(docB)
    expect(history.redo(docA)?.doc).toEqual(docB)
  })
})
