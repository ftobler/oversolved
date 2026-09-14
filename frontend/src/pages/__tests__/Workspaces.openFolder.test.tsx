import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'
import { buildZipBytes } from '@/workspace/zipCarrier'
import { treeWith, documentEntry } from '@/workspace/__tests__/fixtures'
import { freshLocalDb } from './workspacesHarness'
import { readWorkspaceMeta } from '@/workspace/idbCarrier'
import { MANIFEST_PATH } from '@/workspace/paths'
import { getWorkspaceStore } from '@/workspace/store'
import Workspaces from '@/pages/Workspaces'

// U1's open-folder gesture: the picked folder is not just read for adoption, it
// becomes the workspace's save target. The binding is pending (no fingerprint)
// until the first explicit save normalizes the canonical layout into it.

const capability = { can: true, zip: true }
const picker = { result: null as FileSystemDirectoryHandle | null }
const zipPicker = { result: null as FileSystemFileHandle | null }

vi.mock('@/adapters/fileSystemAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/adapters/fileSystemAccess')>()
  return {
    ...actual,
    canPickDirectory: () => capability.can,
    pickLibraryDirectory: async () => picker.result,
    canPickWorkspaceZip: () => capability.zip,
    pickWorkspaceZip: async () => zipPicker.result,
  }
})

function zipHandle(initial: Uint8Array): FileSystemFileHandle {
  const state = { bytes: initial }
  return {
    kind: 'file' as const,
    name: 'ws.zip',
    async getFile() {
      const bytes = state.bytes
      return {
        name: 'ws.zip',
        size: bytes.byteLength,
        lastModified: 0,
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
      }
    },
    async createWritable() {
      let buffer = new Uint8Array(0)
      return {
        async write(data: Uint8Array) { buffer = new Uint8Array(data) },
        async close() { state.bytes = buffer },
        async abort() {},
      }
    },
  } as unknown as FileSystemFileHandle
}

beforeEach(() => {
  freshLocalDb()
  capability.can = true
  capability.zip = true
  picker.result = null
  zipPicker.result = null
})

function wrap() {
  return render(
    <BrowserRouter>
      <Workspaces />
    </BrowserRouter>
  )
}

// The three import gestures now share one toolbar button and a menu.
async function clickImportItem(label: string) {
  await userEvent.click(await screen.findByTitle('Import'))
  await userEvent.click(screen.getByText(label))
}

describe('Workspaces open folder', () => {
  it('binds the picked folder as the save target and normalizes it on the first save', async () => {
    const dir = fakeDirectory('cad')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    picker.result = dir as unknown as FileSystemDirectoryHandle

    wrap()
    await clickImportItem('Import folder')
    await screen.findByText('Gearbox')

    const store = getWorkspaceStore()
    const [summary] = await store.list()
    // The tile can paint from the create row before the landing finishes; wait
    // until the adopted entry is in the working copy.
    await waitFor(async () => {
      expect((await store.listEntries(summary.workspace)).some(e => e.name === 'Gearbox')).toBe(true)
    })
    const meta = await readWorkspaceMeta(summary.workspace)
    expect(meta?.carrier).toEqual({ kind: 'folder', label: 'cad' })
    // A manifest-less folder is pending: land never wrote the canonical layout.
    expect(meta?.loadedFrom).toBeUndefined()
    expect(dir.fileNames()).toEqual(['Gearbox.yaml'])

    await store.save(summary.workspace, (await store.open(summary.workspace)).tree)
    expect(dir.fileNames()).toContain(MANIFEST_PATH)
    await waitFor(async () => {
      expect((await readWorkspaceMeta(summary.workspace))?.loadedFrom?.carrier).toBe('folder')
    })
  })

  it('opens a zip through the file picker and binds it, seeding loadedFrom', async () => {
    const archive = await buildZipBytes(treeWith([
      documentEntry('a', 'Bracket', { text: 'kind: part\n# body\n' }),
    ], 'src'))
    const handle = zipHandle(archive)
    zipPicker.result = handle

    wrap()
    await clickImportItem('Open archive')
    await screen.findByText('Bracket')

    const store = getWorkspaceStore()
    const [summary] = await store.list()
    const meta = await readWorkspaceMeta(summary.workspace)
    expect(meta?.carrier).toEqual({ kind: 'zip', label: 'ws.zip' })
    // A manifest-present archive is not pending: its fingerprint is seeded once
    // the landing finishes (the tile can paint from the create row first).
    await waitFor(async () => {
      expect((await readWorkspaceMeta(summary.workspace))?.loadedFrom?.carrier).toBe('zip')
    })
  })

  // An IDB-only workspace (adopted from a dropped bag, which has no writable
  // handle) can bind a folder later through the tile's save-to-folder action.
  it('binds a folder to an IDB-only workspace through the save-to-folder gesture', async () => {
    const store = getWorkspaceStore()
    const { workspace } = await store.create('Solo', { docKind: 'part' })
    const dir = fakeDirectory('bound')
    picker.result = dir as unknown as FileSystemDirectoryHandle

    wrap()
    await screen.findByText('Solo')
    await userEvent.click(await screen.findByTitle('Save to folder'))

    await waitFor(async () => {
      expect((await readWorkspaceMeta(workspace))?.carrier).toEqual({ kind: 'folder', label: 'bound' })
    })
  })
})
