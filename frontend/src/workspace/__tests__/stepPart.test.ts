// The STEP-into-workspace pair: a content-addressed file entry plus the part
// document that imports it. The tests pin the collision rules the assembly
// gesture relies on: same bytes and name is idempotent, a new name is a second
// view of the same bytes, and a fresh file under a taken name is suffixed.

import { describe, it, expect, beforeEach } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { IdbWorkspaceStore } from '../store'
import { addStepPart } from '../stepPart'
import { resetWorkspaceIdb } from './idbHarness'
import { getFileRegistry } from '@/stores/fileRegistry'
import { CURRENT_DOC_VERSION } from '@/persistence/docSchema'

const STEP_A = new Uint8Array([0x49, 0x53, 0x4f, 0x2d, 0x31, 0x30, 0x33, 0x30, 0x33])
const STEP_B = new Uint8Array([0x49, 0x53, 0x4f, 0x2d, 0x31, 0x30, 0x33, 0x30, 0x33, 0x21])

async function newWorkspace(store: IdbWorkspaceStore): Promise<string> {
  return (await store.create('Assembly', { docKind: 'assembly' })).workspace
}

describe('addStepPart', () => {
  beforeEach(async () => {
    resetWorkspaceIdb()
    await getFileRegistry().clear()
  })

  it('registers the STEP file and the part document that imports it', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)

    const imported = await addStepPart(workspace, STEP_A, { fileName: 'bracket.step' }, store)

    expect(imported).toMatchObject({ name: 'bracket', reused: false })
    const entries = await store.listEntries(workspace)
    expect(entries.find(entry => entry.id === imported.fileId)).toMatchObject({
      kind: 'file', name: 'bracket.step', mime: 'application/step', fileKind: 'step',
    })
    expect(entries.find(entry => entry.id === imported.partId)).toMatchObject({
      kind: 'document', name: 'bracket', docKind: 'part',
    })

    const part = await store.readEntry(workspace, imported.partId)
    const doc = parseYaml(part.text ?? '')
    expect(doc).toMatchObject({ version: CURRENT_DOC_VERSION, kind: 'part' })
    const importedFeature = doc.features.find((feature: { kind: string }) => feature.kind === 'import_step')
    expect(importedFeature.file_id).toBe(imported.fileId)
    expect(importedFeature.label).toBe('bracket.step')

    // Reachable from the workspace graph, not only as a row.
    const opened = await store.open(workspace)
    expect(opened.tree.manifest.references[imported.partId]).toEqual([imported.fileId])
  })

  it('reuses the same file and part when the bytes and name repeat', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const first = await addStepPart(workspace, STEP_A, { fileName: 'bracket.step' }, store)
    const before = await store.listEntries(workspace)

    const again = await addStepPart(workspace, STEP_A, { fileName: 'bracket.step' }, store)

    expect(again).toEqual({
      partId: first.partId, fileId: first.fileId, name: 'bracket', reused: true,
    })
    expect(await store.listEntries(workspace)).toHaveLength(before.length)
  })

  it('shares the stored bytes when the same file is imported under another name', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const first = await addStepPart(workspace, STEP_A, { fileName: 'bracket.step' }, store)

    const copy = await addStepPart(workspace, STEP_A, { fileName: 'bracket.step', name: 'Mirror bracket' }, store)

    expect(copy.fileId).toBe(first.fileId)
    expect(copy.partId).not.toBe(first.partId)
    expect(copy.name).toBe('Mirror bracket')
    expect((await store.listEntries(workspace)).filter(entry => entry.kind === 'file')).toHaveLength(1)
  })

  it('suffixes a taken name for a different file', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const first = await addStepPart(workspace, STEP_A, { fileName: 'bracket.step' }, store)

    const second = await addStepPart(workspace, STEP_B, { fileName: 'bracket.step' }, store)

    expect(second.fileId).not.toBe(first.fileId)
    expect(second.name).toBe('bracket_1')
  })

  it('prefers a supplied name over the file name', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)

    const imported = await addStepPart(workspace, STEP_A, { fileName: 'part-42.step', name: 'Bracket' }, store)

    expect(imported.name).toBe('Bracket')
  })

  it('refuses an empty file before writing anything', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const before = await store.listEntries(workspace)

    await expect(addStepPart(workspace, new Uint8Array(0), { fileName: 'empty.step' }, store))
      .rejects.toThrow(/empty/)
    expect(await store.listEntries(workspace)).toHaveLength(before.length)
  })
})
