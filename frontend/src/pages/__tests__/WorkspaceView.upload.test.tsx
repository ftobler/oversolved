import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { freshLocalDb, seedStore } from './workspacesHarness'
import { createWorkspaceSession } from '@/workspace/session'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { parse as parseYaml } from 'yaml'

vi.mock('@/stores/previewStore', async importOriginal => ({
  ...(await importOriginal<typeof import('@/stores/previewStore')>()),
  usePreview: () => undefined,
}))

import WorkspaceView from '@/pages/WorkspaceView'

// The header's Upload control, end to end against the real workspace seam: the
// picked file joins THIS workspace, classified the way a library import would
// classify it, and the view does not navigate away (several may follow).

function pickedFile(name: string, bytes: Uint8Array, type = ''): File {
  return {
    name,
    size: bytes.byteLength,
    type,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  } as unknown as File
}

async function openWorkspace(): Promise<string> {
  const store = seedStore()
  const { workspace } = await store.create('Shop')
  useWorkspaceSessionStore.setState({ session: createWorkspaceSession(workspace, store) })
  render(
    <MemoryRouter initialEntries={[`/workspaces/${workspace}`]}>
      <Routes>
        <Route path="/workspaces/:workspaceId" element={<WorkspaceView />} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<div>EDITOR</div>} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByText('Entries')
  return workspace
}

async function upload(file: File) {
  const input = screen.getByLabelText('Upload file') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

// Adoption does several trailing IDB writes; drain them before teardown.
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  freshLocalDb()
  useWorkspaceSessionStore.setState({ session: null })
})

describe('WorkspaceView upload', () => {
  it('is a keyboard-reachable file input, not a display:none one', async () => {
    await openWorkspace()
    const input = screen.getByLabelText('Upload file') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.style.display).not.toBe('none')
    expect(input.hidden).toBe(false)
    expect(input.tabIndex).not.toBe(-1)
    expect(input.closest('label')).not.toBeNull()
  })

  it('lands a STEP upload as a file entry plus a part that imports it', async () => {
    const workspace = await openWorkspace()
    const bytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-STEP;\n')

    await upload(pickedFile('bracket.step', bytes))
    await settle()

    const store = seedStore()
    const entries = await store.listEntries(workspace)
    const file = entries.find(e => e.kind === 'file')
    const part = entries.find(e => e.name === 'bracket')
    // The seed document the workspace was created with, plus the two new rows.
    expect(entries).toHaveLength(3)
    expect(file).toMatchObject({ name: 'bracket.step', fileKind: 'step' })
    expect(part).toMatchObject({ name: 'bracket', docKind: 'part' })
    const text = (await store.readEntry(workspace, part!.id)).text ?? ''
    const features = (parseYaml(text) as { features: { kind: string; file_id?: string }[] }).features
    expect(features.find(f => f.kind === 'import_step')?.file_id).toBe(file!.id)
    // No navigation: the rows appear in place.
    await waitFor(() => expect(screen.getByLabelText('bracket')).toBeTruthy())
    expect(screen.queryByText('EDITOR')).toBeNull()
  })

  it('lands any other file as one file entry', async () => {
    const workspace = await openWorkspace()

    await upload(pickedFile('notes.txt', new TextEncoder().encode('hello'), 'text/plain'))
    await settle()

    const entries = await seedStore().listEntries(workspace)
    const files = entries.filter(e => e.kind === 'file')
    expect(entries).toHaveLength(2)  // the seed document and the upload
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ name: 'notes.txt' })
    // The row's name, not the origin line under it that names the same file.
    await screen.findByText('notes.txt', { selector: '.workspace-entry-name' })
  })
})
