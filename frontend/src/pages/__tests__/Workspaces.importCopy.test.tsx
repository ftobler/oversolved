import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'
import { buildZipBytes } from '@/workspace/zipCarrier'
import { bytesOf, documentEntry, fileEntry, treeWith } from '@/workspace/__tests__/fixtures'
import { freshLocalDb } from './workspacesHarness'
import Workspaces from '@/pages/Workspaces'

// U5: the import gesture states, at the moment it happens, that it copies and
// how many entries came with it. That wording is the only place the copy
// semantics is told to the user.

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

describe('Workspaces import copy wording (U5)', () => {
  it('states the copy and the count for a folder import', async () => {
    const dir = fakeDirectory('cad')
    dir.putText('Gearbox.yaml', 'kind: part\n')
    picker.result = dir as unknown as FileSystemDirectoryHandle

    wrap()
    await userEvent.click(await screen.findByTitle('Import a folder'))

    expect(await screen.findByText(/Copied 1 entries into this workspace/)).toBeInTheDocument()
    expect(screen.getByText(/Edits to the source will not propagate/)).toBeInTheDocument()
    expect(screen.getByText(/Origins panel/)).toBeInTheDocument()
  })

  it('states the copy and the count for a zip opened through the picker', async () => {
    const archive = await buildZipBytes(treeWith([
      documentEntry('a', 'Bracket', { text: 'kind: part\n' }),
      fileEntry('b', 'b.step', bytesOf([1, 2, 3]), 'application/step'),
    ], 'src'))
    zipPicker.result = zipHandle(archive)

    wrap()
    await userEvent.click(await screen.findByTitle('Open a workspace archive'))

    expect(await screen.findByText(/Copied 2 entries into this workspace/)).toBeInTheDocument()
  })

  it('states the copy and the count for a bare file', async () => {
    wrap()
    await waitFor(() => expect(screen.getByText('No workspaces yet.')).toBeInTheDocument())

    const input = document.querySelector<HTMLInputElement>('.doc-controls input.file-upload-input')!
    const bytes = new TextEncoder().encode('kind: part\n')
    const file = {
      name: 'widget.yaml',
      size: bytes.byteLength,
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    } as unknown as File
    fireEvent.change(input, { target: { files: [file] } })

    expect(await screen.findByText(/Copied 1 entries into this workspace/)).toBeInTheDocument()
  })
})
