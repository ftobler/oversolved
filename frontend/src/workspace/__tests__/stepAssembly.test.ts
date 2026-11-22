// The STEP-into-an-assembly writers: B1 is the lone part inside a new assembly,
// B2 one part per solid from per-solid STEP bytes the kernel already wrote. The
// tests pin the collision rules, the fixed first instance, the naming scheme
// and the single save, and that a one-solid split is B1 exactly.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { IdbWorkspaceStore } from '../store'
import { addStepAssembly, addStepPart, STEP_NO_SOLIDS } from '../stepPart'
import { resetWorkspaceIdb } from './idbHarness'
import { getFileRegistry } from '@/persistence/fileRegistry'
import { buildStepContent } from '@/persistence/stepImport'
import { CURRENT_DOC_VERSION } from '@/persistence/docSchema'

const STEP_A = new Uint8Array([0x49, 0x53, 0x4f, 0x2d, 0x31, 0x30, 0x33, 0x30, 0x33])
const STEP_B = new Uint8Array([0x49, 0x53, 0x4f, 0x2d, 0x31, 0x30, 0x33, 0x30, 0x33, 0x21])
const SOLID_1 = new Uint8Array([0x53, 0x4f, 0x4c, 0x49, 0x44, 0x2d, 0x31])
const SOLID_2 = new Uint8Array([0x53, 0x4f, 0x4c, 0x49, 0x44, 0x2d, 0x32])
const SOLID_3 = new Uint8Array([0x53, 0x4f, 0x4c, 0x49, 0x44, 0x2d, 0x33])

interface Feature {
  id: string
  kind: string
  instance?: {
    handle: string
    doc_id: string
    doc_rev: number
    transform: Record<string, number>
    visible: boolean
    fixed?: boolean
  }
}

async function newWorkspace(store: IdbWorkspaceStore): Promise<string> {
  return (await store.create('Assembly', { docKind: 'assembly' })).workspace
}

async function assemblyOf(store: IdbWorkspaceStore, workspace: string, id: string): Promise<Feature[]> {
  const text = (await store.readEntry(workspace, id)).text ?? ''
  return (parseYaml(text) as { features: Feature[] }).features
}

describe('addStepAssembly mode B1', () => {
  beforeEach(async () => {
    resetWorkspaceIdb()
    await getFileRegistry().clear()
  })

  it('writes one file, one part and one assembly holding that part fixed', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const save = vi.spyOn(store, 'save')

    const imported = await addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step', mode: 'assembly_one_part',
    }, store)

    expect(save).toHaveBeenCalledTimes(1)
    expect(imported.name).toBe('bracket')
    expect(imported.parts).toHaveLength(1)
    const entries = await store.listEntries(workspace)
    expect(entries.filter(entry => entry.kind === 'file')).toHaveLength(1)
    expect(entries.filter(entry => entry.kind === 'document' && entry.docKind === 'part')).toHaveLength(1)
    expect(entries.find(entry => entry.id === imported.assemblyId)).toMatchObject({
      kind: 'document', name: 'bracket', docKind: 'assembly',
    })

    const features = await assemblyOf(store, workspace, imported.assemblyId)
    expect(features).toHaveLength(1)
    const instance = features[0].instance!
    expect(instance.doc_id).toBe(imported.parts[0].id)
    expect(instance.fixed).toBe(true)
    expect(instance.transform).toEqual({ tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 })

    // Reachable from the workspace graph: assembly -> part -> file.
    const opened = await store.open(workspace)
    expect(opened.tree.manifest.references[imported.assemblyId]).toEqual([imported.parts[0].id])
    expect(opened.tree.manifest.references[imported.parts[0].id]).toEqual([imported.parts[0].fileId])
  })

  it('reuses the file and part, and suffixes the second assembly name', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const first = await addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step', mode: 'assembly_one_part',
    }, store)

    const second = await addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step', mode: 'assembly_one_part',
    }, store)

    expect(second.parts[0]).toEqual(first.parts[0])
    expect(second.parts[0].fileId).toBe(first.parts[0].fileId)
    expect(second.name).toBe('bracket_1')
    const entries = await store.listEntries(workspace)
    expect(entries.filter(entry => entry.kind === 'file')).toHaveLength(1)
    expect(entries.filter(entry => entry.kind === 'document' && entry.docKind === 'part')).toHaveLength(1)
  })

  // Mode A and B1 must be the same import, only placed: the same shared
  // STEP-part builder mints the document, so the import_step feature id and
  // label are the only per-import values and the naming derivation (which folds
  // that feature id into every face UUID) cannot drift between the two.
  it('mints the part document through the shared STEP-part builder', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const imported = await addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step', mode: 'assembly_one_part',
    }, store)

    const text = (await store.readEntry(workspace, imported.parts[0].id)).text ?? ''
    const doc = parseYaml(text) as { version: number; features: { id: string; kind: string }[] }
    expect(doc.version).toBe(CURRENT_DOC_VERSION)
    const feature = doc.features.find(f => f.kind === 'import_step')!
    expect(text).toBe(buildStepContent(imported.parts[0].fileId, feature.id, 'bracket.step'))
  })

  it('fills an existing document row instead of adding a second one', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    // The seed document a fresh workspace is created with shares the workspace id.
    expect((await store.listEntries(workspace)).filter(entry => entry.kind === 'document')).toHaveLength(1)

    const imported = await addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step', mode: 'assembly_one_part', assemblyId: workspace,
    }, store)

    expect(imported.assemblyId).toBe(workspace)
    const documents = (await store.listEntries(workspace)).filter(entry => entry.kind === 'document')
    expect(documents).toHaveLength(2)  // the seed became the assembly, plus the part
    expect(documents.find(entry => entry.id === workspace)).toMatchObject({ name: 'bracket', docKind: 'assembly' })
  })
})

describe('addStepAssembly mode B2', () => {
  beforeEach(async () => {
    resetWorkspaceIdb()
    await getFileRegistry().clear()
  })

  it('writes one file and one part per solid, in solid order', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const save = vi.spyOn(store, 'save')

    const imported = await addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step', mode: 'assembly_split', solids: [SOLID_1, SOLID_2, SOLID_3],
    }, store)

    expect(save).toHaveBeenCalledTimes(1)
    expect(imported.parts.map(part => part.name)).toEqual(['bracket_1', 'bracket_2', 'bracket_3'])
    expect(imported.fileIds).toHaveLength(3)
    const files = (await store.listEntries(workspace)).filter(entry => entry.kind === 'file')
    expect(files.map(file => file.name).sort()).toEqual(['bracket_1.step', 'bracket_2.step', 'bracket_3.step'])
    expect(files.map(file => file.id).sort()).toEqual([...imported.fileIds].sort())

    const features = await assemblyOf(store, workspace, imported.assemblyId)
    expect(features.map(feature => feature.instance!.doc_id)).toEqual(imported.parts.map(part => part.id))
    // Only the first instance anchors the assembly; the rest keep their seed
    // pose and must not be pinned by the import.
    expect(features.map(feature => feature.instance!.fixed)).toEqual([true, undefined, undefined])
  })

  it('shares one file entry between two identical solids but keeps a part each', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)

    const imported = await addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step', mode: 'assembly_split', solids: [SOLID_1, SOLID_1],
    }, store)

    expect(imported.fileIds[0]).toBe(imported.fileIds[1])
    expect(imported.parts[0].fileId).toBe(imported.parts[1].fileId)
    expect(imported.parts[0].id).not.toBe(imported.parts[1].id)
    expect((await store.listEntries(workspace)).filter(entry => entry.kind === 'file')).toHaveLength(1)
  })

  it('imports a one-solid split as B1, from the original bytes', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)

    const imported = await addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step', mode: 'assembly_split', solids: [SOLID_1],
    }, store)

    expect(imported.parts).toHaveLength(1)
    expect(imported.parts[0].name).toBe('bracket')
    const file = await store.readEntry(workspace, imported.parts[0].fileId)
    expect(file.bytes).toEqual(STEP_A)
    const features = await assemblyOf(store, workspace, imported.assemblyId)
    expect(features).toHaveLength(1)
    expect(features[0].instance!.fixed).toBe(true)
  })

  it('refuses a file with no solids and writes nothing', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const before = await store.listEntries(workspace)
    const save = vi.spyOn(store, 'save')

    await expect(addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step', mode: 'assembly_split', solids: [],
    }, store)).rejects.toThrow(STEP_NO_SOLIDS)

    expect(save).not.toHaveBeenCalled()
    expect(await store.listEntries(workspace)).toHaveLength(before.length)
  })

  it('writes only the parts when the caller already holds the assembly', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)
    const before = (await store.listEntries(workspace)).filter(entry => entry.kind === 'document')

    const imported = await addStepAssembly(workspace, STEP_A, {
      fileName: 'bracket.step',
      mode: 'assembly_split',
      solids: [SOLID_1, SOLID_2],
      intoAssembly: 'open-assembly',
    }, store)

    expect(imported.assemblyId).toBe('open-assembly')
    expect(imported.name).toBeUndefined()
    const documents = (await store.listEntries(workspace)).filter(entry => entry.kind === 'document')
    // The seed document plus the two parts: nothing was added for the assembly.
    expect(documents).toHaveLength(before.length + 2)
    expect(imported.parts.map(part => part.name)).toEqual(['bracket_1', 'bracket_2'])
  })
})

// The pair writer keeps its own rules: mode B must not change what a plain
// STEP import into an open workspace does.
describe('addStepPart', () => {
  beforeEach(async () => {
    resetWorkspaceIdb()
    await getFileRegistry().clear()
  })

  it('still imports the whole file as one part', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await newWorkspace(store)

    const imported = await addStepPart(workspace, STEP_B, { fileName: 'plate.step' }, store)

    expect(imported).toMatchObject({ name: 'plate', reused: false })
    expect((await store.listEntries(workspace)).filter(entry => entry.kind === 'file')).toHaveLength(1)
  })
})
