// The picked-file entry point's STEP modes: A stays adoption's pair, B1 and B2
// create the workspace and land the assembly inside it, and a split that cannot
// run (no kernel, nothing to split) refuses without leaving a workspace behind.
// The kernel split is mocked: its own real-OCC test pins what it produces.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { IdbWorkspaceStore } from '../store'
import { resetWorkspaceIdb } from './idbHarness'
import { getFileRegistry } from '@/persistence/fileRegistry'
import { importPickedFile } from '../importFile'
import { STEP_NO_SOLIDS } from '../stepPart'
import { splitStepViaWorker } from '@/kernel/worker/solverClient'

vi.mock('@/kernel/worker/solverClient', () => ({ splitStepViaWorker: vi.fn() }))

const STEP = new Uint8Array([0x49, 0x53, 0x4f, 0x2d, 0x31, 0x30, 0x33, 0x30, 0x33])
const SOLID_1 = new Uint8Array([0x53, 0x4f, 0x4c, 0x49, 0x44, 0x2d, 0x31])
const SOLID_2 = new Uint8Array([0x53, 0x4f, 0x4c, 0x49, 0x44, 0x2d, 0x32])
const SOLID_3 = new Uint8Array([0x53, 0x4f, 0x4c, 0x49, 0x44, 0x2d, 0x33])

function pickedFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.byteLength,
    type: '',
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  } as unknown as File
}

const split = vi.mocked(splitStepViaWorker)

describe('importPickedFile STEP modes', () => {
  beforeEach(async () => {
    resetWorkspaceIdb()
    await getFileRegistry().clear()
    split.mockReset()
  })

  it('keeps mode A on adoption and never asks the kernel to split', async () => {
    const store = new IdbWorkspaceStore()

    const result = await importPickedFile(pickedFile('bracket.step', STEP), { stepMode: 'part' }, store)

    expect(split).not.toHaveBeenCalled()
    expect(result.step).toBeUndefined()
    expect(result.synthesizedParts).toBe(1)
    expect((await store.listEntries(result.workspace)).filter(entry => entry.kind === 'file')).toHaveLength(1)
  })

  it('lands B1 in a fresh workspace whose seed row becomes the assembly', async () => {
    const store = new IdbWorkspaceStore()

    const result = await importPickedFile(pickedFile('bracket.step', STEP), {
      stepMode: 'assembly_one_part',
    }, store)

    expect(split).not.toHaveBeenCalled()
    expect(result.mode).toBe('new')
    expect(result.step?.partIds).toHaveLength(1)
    const entries = await store.listEntries(result.workspace)
    const documents = entries.filter(entry => entry.kind === 'document')
    // The seed document was filled as the assembly: one assembly, one part.
    expect(documents).toHaveLength(2)
    expect(documents.filter(entry => entry.docKind === 'assembly')).toHaveLength(1)
    expect(documents.filter(entry => entry.docKind === 'part')).toHaveLength(1)
    expect(result.step?.assemblyId).toBe(result.workspace)
    expect(result.documents).toBe(2)
    expect(result.files).toBe(1)
    expect(result.synthesizedParts).toBe(1)
  })

  it('lands B2 as one part per split solid, each importing its own file', async () => {
    split.mockResolvedValueOnce({
      solids: [
        { bytes: SOLID_1, volume: 1 },
        { bytes: SOLID_2, volume: 2 },
        { bytes: SOLID_3, volume: 3 },
      ],
      leftovers: 2,
    })
    const store = new IdbWorkspaceStore()

    const result = await importPickedFile(pickedFile('bracket.step', STEP), {
      stepMode: 'assembly_split',
    }, store)

    expect(split).toHaveBeenCalledWith(STEP)
    expect(result.step?.partIds).toHaveLength(3)
    expect(result.step?.leftovers).toBe(2)
    const partDocs = []
    for (const partId of result.step!.partIds) {
      partDocs.push(parseYaml((await store.readEntry(result.workspace, partId)).text ?? '') as {
        features: { kind: string; file_id?: string }[]
      })
    }
    const fileIds = partDocs.map(doc => doc.features.find(f => f.kind === 'import_step')!.file_id)
    expect(fileIds).toEqual(result.step!.fileIds)
    const stored = await Promise.all(result.step!.fileIds.map(id => store.readEntry(result.workspace, id)))
    expect(stored.map(entry => entry.bytes)).toEqual([SOLID_1, SOLID_2, SOLID_3])
  })

  it('refuses a file with no solids before creating a workspace', async () => {
    split.mockResolvedValueOnce({ solids: [], leftovers: 4 })
    const store = new IdbWorkspaceStore()

    await expect(importPickedFile(pickedFile('faces.step', STEP), {
      stepMode: 'assembly_split',
    }, store)).rejects.toThrow(STEP_NO_SOLIDS)
    expect(await store.list()).toEqual([])
  })

  it('refuses a split when the kernel is unavailable', async () => {
    split.mockResolvedValueOnce(null)
    const store = new IdbWorkspaceStore()

    await expect(importPickedFile(pickedFile('bracket.step', STEP), {
      stepMode: 'assembly_split',
    }, store)).rejects.toThrow(/local kernel/)
    expect(await store.list()).toEqual([])
  })

  it('joins an open workspace instead of creating one', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Shop')

    const result = await importPickedFile(pickedFile('bracket.step', STEP), {
      into: workspace, stepMode: 'assembly_one_part',
    }, store)

    expect(result).toMatchObject({ workspace, mode: 'join' })
    expect(await store.list()).toHaveLength(1)
    expect((await store.listEntries(workspace)).filter(entry => entry.docKind === 'assembly')).toHaveLength(1)
  })
})
