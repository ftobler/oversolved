// @vitest-environment node
//
// The assembly `out` contract: the workspace zip is the hand-off format, and a
// bare YAML/JSON document carries a note naming the part documents it leaves
// behind, because its part_instance.doc_id values cannot resolve there.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import { assemblyBareOutNote, assemblyPartDocIds } from '../assemblyOut'

const IDENTITY = {
  tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
}

function assembly(docIds: string[]): AssemblyDoc {
  return {
    version: 3,
    kind: 'assembly',
    features: docIds.map((docId, index) => ({
      id: `inst_${index}`,
      kind: 'part_instance' as const,
      instance: { handle: `h${index}`, doc_id: docId, doc_rev: 0, transform: { ...IDENTITY } },
    })),
  }
}

describe('assemblyPartDocIds', () => {
  it('reads every distinct part document the instances name', () => {
    const doc = assembly(['plate', 'pin', 'plate'])
    doc.features!.push({ id: 'base', kind: 'origin' })
    expect(assemblyPartDocIds(doc)).toEqual(['plate', 'pin'])
  })

  it('is empty for an assembly with no instances', () => {
    expect(assemblyPartDocIds(assembly([]))).toEqual([])
  })
})

describe('assemblyBareOutNote', () => {
  it('names every bound doc_id and points at the zip hand-off', () => {
    const note = assemblyBareOutNote(assembly(['plate', 'pin']))
    expect(note).not.toBeNull()
    expect(note).toContain('plate')
    expect(note).toContain('pin')
    expect(note).toContain('part_instance')
    expect(note).toContain('.zip')
  })

  it('nothing to warn about when the assembly instances no part', () => {
    expect(assemblyBareOutNote(assembly([]))).toBeNull()
  })
})
