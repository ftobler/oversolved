// @vitest-environment node
//
// The `.zip` hand-off: an assembly, its bound parts and their files become a
// workspace archive whose ids the assembly text already names, so the import
// adoption path lands a workspace where every part_instance.doc_id resolves.

import { describe, it, expect, beforeEach } from 'vitest'
import type { AssemblyDoc, PartDoc } from '@/types/cad'
import { buildAssemblyWorkspaceTree, buildAssemblyWorkspaceZip } from '../assemblyWorkspaceZip'
import { readZipBag, importBag } from '@/workspace/import'
import { readZipTree } from '@/workspace/zipCarrier'
import { IdbWorkspaceStore } from '@/workspace/store'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'

const plate: PartDoc = {
  version: 3, kind: 'part',
  features: [{ id: 'sk1', kind: 'sketch' }, { id: 'ex1', kind: 'extrude' }],
} as unknown as PartDoc

const pin: PartDoc = {
  version: 3, kind: 'part',
  features: [
    { id: 'sk1', kind: 'sketch' },
    { id: 'ex1', kind: 'extrude' },
    { id: 'imp1', kind: 'import_step', file_id: 'f1' },
  ],
} as unknown as PartDoc

const doc: AssemblyDoc = {
  version: 3,
  kind: 'assembly',
  features: [
    { id: 'inst_plate', kind: 'part_instance', instance: {
      handle: 'plate', doc_id: 'plate', doc_rev: 0, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, fixed: true,
    } },
    { id: 'inst_pin', kind: 'part_instance', instance: {
      handle: 'pin', doc_id: 'pin', doc_rev: 0, transform: { tx: 50, ty: 30, tz: 10, qx: 0, qy: 0, qz: 0, qw: 1 },
    } },
  ],
}

const PARTS = { plate, pin }
const FILES = new Map([['f1', new Uint8Array([1, 2, 3])]])

describe('assembly workspace zip', () => {
  beforeEach(resetWorkspaceIdb)

  it('writes the assembly, its parts and their files with reference edges', async () => {
    const tree = buildAssemblyWorkspaceTree({ doc, parts: PARTS, files: FILES })
    const rows = Object.entries(tree.manifest.entries)
    const documents = rows.filter(([, row]) => row.kind === 'document')
    expect(documents).toHaveLength(3)
    expect(documents.map(([, row]) => row.docKind).sort()).toEqual(['assembly', 'part', 'part'])
    expect(rows.filter(([, row]) => row.kind === 'file')).toHaveLength(1)

    const assemblyId = documents.find(([, row]) => row.docKind === 'assembly')![0]
    const partIds = documents.filter(([, row]) => row.docKind === 'part').map(([id]) => id).sort()
    expect(tree.manifest.references[assemblyId]).toEqual(partIds)
    // The part that names the file has the edge the import path would discover.
    const pinId = partIds.find(id => id === 'pin')!
    expect(tree.manifest.references[pinId]).toEqual(['f1'])
  })

  it('re-reads from zip bytes and imports into a workspace with no dangling doc_id', async () => {
    const bytes = await buildAssemblyWorkspaceZip({ doc, parts: PARTS, files: FILES })
    const reread = await readZipTree(bytes)
    expect(Object.values(reread.manifest.entries).filter(row => row.kind === 'document')).toHaveLength(3)

    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'zip'), { origin: 'zip' }, store)
    expect(result.mode).toBe('new')
    expect(result.documents).toBe(3)
    expect(result.files).toBe(1)

    // Every instance's doc_id must resolve to a live part entry after adoption.
    const opened = await store.readEntry(result.workspace, 'plate')
    expect(opened.kind).toBe('document')
    expect(opened.docKind).toBe('part')
    expect((await store.readEntry(result.workspace, 'pin')).kind).toBe('document')
    expect((await store.readEntry(result.workspace, 'f1')).kind).toBe('file')

    const assembly = await store.readEntry(result.workspace, Object.entries(reread.manifest.entries)
      .find(([, row]) => row.docKind === 'assembly')![0])
    expect(assembly.text).toContain('doc_id: plate')
    expect(assembly.text).toContain('doc_id: pin')
  })
})
