// @vitest-environment node
//
// The assembly `out` contract: the workspace zip is the hand-off format, and a
// bare YAML/JSON document carries a note naming the part documents it leaves
// behind, because its part_instance.doc_id values cannot resolve there.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import { assemblyBareOutNote, assemblyOutIsZip, assemblyOutPath, assemblyPartDocIds } from '../assemblyOut'

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

describe('assemblyOutPath', () => {
  it('defaults a path with no extension or a directory-style path to the zip', () => {
    expect(assemblyOutPath('tmp/hand-off')).toBe('tmp/hand-off.zip')
    expect(assemblyOutPath('tmp/hand-off/')).toBe('tmp/hand-off.zip')
    // A dot earlier in the path is a directory name, not a file extension.
    expect(assemblyOutPath('tmp/v1.2/hand-off')).toBe('tmp/v1.2/hand-off.zip')
  })

  it('keeps an explicit document or zip path as written, once', () => {
    expect(assemblyOutPath('tmp/hand-off.json')).toBe('tmp/hand-off.json')
    expect(assemblyOutPath('tmp/hand-off.yaml')).toBe('tmp/hand-off.yaml')
    expect(assemblyOutPath('tmp/hand-off.zip')).toBe('tmp/hand-off.zip')
    expect(assemblyOutPath('tmp/hand-off.zip/')).toBe('tmp/hand-off.zip')
  })

  it('leaves a bare root, or an empty path, to the resolver', () => {
    expect(assemblyOutPath('tmp')).toBe('tmp')
    expect(assemblyOutPath('tmp/')).toBe('tmp/')
    expect(assemblyOutPath('')).toBe('')
    expect(assemblyOutPath('  ')).toBe('  ')
  })
})

describe('assemblyOutIsZip', () => {
  it('reads the zip extension in either case', () => {
    expect(assemblyOutIsZip('tmp/hand-off.zip')).toBe(true)
    expect(assemblyOutIsZip('tmp/hand-off.ZIP')).toBe(true)
    expect(assemblyOutIsZip('tmp/hand-off.json')).toBe(false)
    expect(assemblyOutIsZip('tmp/hand-off')).toBe(false)
  })
})

describe('assemblyPartDocIds', () => {
  it('reads every distinct part document the instances name, sorted', () => {
    const doc = assembly(['plate', 'pin', 'plate'])
    doc.features!.push({ id: 'base', kind: 'origin' })
    expect(assemblyPartDocIds(doc)).toEqual(['pin', 'plate'])
  })

  it('is empty for an assembly with no instances', () => {
    expect(assemblyPartDocIds(assembly([]))).toEqual([])
  })
})

describe('assemblyBareOutNote', () => {
  it('names one bound doc_id in the pinned sentence', () => {
    expect(assemblyBareOutNote(assembly(['plate']))).toEqual({
      ids: ['plate'],
      text: 'The out file holds the assembly document alone: part document plate is not in it, '
        + 'so its part_instance doc_ids do not resolve. Use a .zip out for a self-contained hand-off '
        + '(the assembly plus every bound part and file).',
    })
  })

  it('names two bound doc_ids in the pinned plural sentence', () => {
    expect(assemblyBareOutNote(assembly(['plate', 'pin']))).toEqual({
      ids: ['pin', 'plate'],
      text: 'The out file holds the assembly document alone: part documents pin, plate are not in it, '
        + 'so its part_instance doc_ids do not resolve. Use a .zip out for a self-contained hand-off '
        + '(the assembly plus every bound part and file).',
    })
  })

  it('nothing to warn about when the assembly instances no part', () => {
    expect(assemblyBareOutNote(assembly([]))).toBeNull()
  })
})
