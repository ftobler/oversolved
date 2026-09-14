import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { freshLocalDb, renderWorkspaces, seedStore } from './workspacesHarness'

// The slow verbs (import, export, duplicate) run against IndexedDB or the File
// System Access API and can take long enough for a second click to land. Each
// one must go visibly busy and refuse the duplicate submit until it settles.

const access = vi.hoisted(() => ({
  can: true,
  pickDirectory: vi.fn<() => Promise<FileSystemDirectoryHandle | null>>(),
}))

vi.mock('@/adapters/fileSystemAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/adapters/fileSystemAccess')>()
  return {
    ...actual,
    canPickDirectory: () => access.can,
    pickLibraryDirectory: () => access.pickDirectory(),
    canPickWorkspaceZip: () => false,
    pickWorkspaceZip: async () => null,
  }
})

describe('Workspaces slow verbs', () => {
  beforeEach(() => {
    freshLocalDb()
    localStorage.clear()
    access.can = true
    access.pickDirectory.mockReset()
    access.pickDirectory.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('disables a duplicate while it runs and re-enables it after', async () => {
    await seedStore().create('Alpha', { docKind: 'part' })
    const store = seedStore()
    let resolveDuplicate: (value: { workspace: string }) => void = () => {}
    const pending = new Promise<{ workspace: string }>(resolve => { resolveDuplicate = resolve })
    vi.spyOn(store, 'duplicate').mockReturnValueOnce(pending)

    renderWorkspaces()
    await screen.findByText('Alpha')

    const duplicate = screen.getByTitle('Duplicate') as HTMLButtonElement
    fireEvent.click(duplicate)
    expect(duplicate).toBeDisabled()
    expect(duplicate.querySelector('.material-icons')?.textContent).toBe('hourglass_empty')

    // A second click while the first is in flight must not start a second copy.
    fireEvent.click(duplicate)
    expect(store.duplicate).toHaveBeenCalledTimes(1)

    resolveDuplicate({ workspace: 'copy' })
    await waitFor(() => expect(duplicate).toBeEnabled())
    expect(duplicate.querySelector('.material-icons')?.textContent).toBe('content_copy')
  })

  it('disables the import trigger while an import runs', async () => {
    let resolvePick: (dir: FileSystemDirectoryHandle | null) => void = () => {}
    access.pickDirectory.mockReturnValueOnce(new Promise(resolve => { resolvePick = resolve }))

    renderWorkspaces()
    await screen.findByText('No workspaces yet.')

    const trigger = screen.getByLabelText('Import') as HTMLButtonElement
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByText('Import folder'))

    // The picker is still open (the gesture has not been cancelled), so the
    // whole shared import flag holds the trigger down.
    expect(trigger).toBeDisabled()
    expect(trigger.querySelector('.material-icons')?.textContent).toBe('hourglass_empty')

    resolvePick(null)
    await waitFor(() => expect(trigger).toBeEnabled())
    expect(trigger.querySelector('.material-icons')?.textContent).toBe('upload')
  })
})
