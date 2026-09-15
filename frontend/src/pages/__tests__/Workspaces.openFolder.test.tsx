import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'
import { buildZipBytes } from '@/workspace/zipCarrier'
import { treeWith, documentEntry } from '@/workspace/__tests__/fixtures'
import { freshLocalDb } from './workspacesHarness'
import { getWorkspaceStore } from '@/workspace/store'
import Workspaces from '@/pages/Workspaces'

// U1's folder and archive gestures under the storage collapse: both read, and
// only read. The entries land in IndexedDB, which is where they now live, and
// the picked folder or archive is left exactly as it was found -- there is no
// binding, so no later save can reach back into it.

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
  it('copies the picked folder in and leaves it untouched, saves included', async () => {
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

    await store.save(summary.workspace, (await store.open(summary.workspace)).tree)
    // No manifest, no canonical layout, no rewrite: the folder was a source.
    expect(dir.fileNames()).toEqual(['Gearbox.yaml'])
  })

  it('copies a picked archive in and never writes back to it', async () => {
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
    await store.save(summary.workspace, (await store.open(summary.workspace)).tree)

    const after = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    expect(after).toEqual(archive)
  })
})
