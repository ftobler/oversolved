import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useLibraryStore } from '@/stores/libraryStore'
import { activeLibrary, BROWSER_LIBRARY_LABEL } from '@/adapters/library'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The platform edges are mocked; what is under test is the decision table
// between them. `capability.can` flips the whole feature off, which is the
// Firefox/Safari shape.
const capability = { can: true, canFile: true }
const picker = {
  result: null as FileSystemDirectoryHandle | null,
  file: null as FileSystemFileHandle | null,
  error: null as Error | null,
}
const registry = {
  restored: null as FileSystemDirectoryHandle | null,
  reopened: null as FileSystemDirectoryHandle | null,
  name: null as string | null,
  remembered: [] as FileSystemDirectoryHandle[],
  forgotten: 0,
}

vi.mock('@/adapters/fileSystemAccess', () => ({
  canPickDirectory: () => capability.can,
  canPickFiles: () => capability.canFile,
  pickLibraryDirectory: async () => {
    if (picker.error) throw picker.error
    return picker.result
  },
  pickDocumentToOpen: async () => {
    if (picker.error) throw picker.error
    return picker.file
  },
}))

vi.mock('@/stores/documentStore/libraryHandleRegistry', () => ({
  rememberLibraryHandle: async (h: FileSystemDirectoryHandle) => { registry.remembered.push(h) },
  restoreLibraryHandle: async () => registry.restored,
  reopenLibraryHandle: async () => registry.reopened,
  rememberedLibraryName: async () => registry.name,
  forgetLibraryHandle: async () => { registry.forgotten += 1 },
}))

const cad = () => fakeDirectory('cad') as unknown as FileSystemDirectoryHandle

beforeEach(() => {
  capability.can = true
  capability.canFile = true
  picker.result = null
  picker.file = null
  picker.error = null
  registry.restored = null
  registry.reopened = null
  registry.name = null
  registry.remembered = []
  registry.forgotten = 0
  useLibraryStore.getState().useBrowserStorage()
  useLibraryStore.setState({
    remembered: null, error: null, canOpenFolder: false, canOpenFile: false,
  })
})

describe('libraryStore', () => {
  it('starts on browser storage', () => {
    expect(useLibraryStore.getState().kind).toBe('browser')
    expect(useLibraryStore.getState().label).toBe(BROWSER_LIBRARY_LABEL)
    expect(activeLibrary().kind).toBe('browser')
  })

  // The capability answer comes from boot, not from module evaluation: reading
  // the platform mid-import makes the answer depend on import order.
  it('learns whether folders can be picked at boot', async () => {
    expect(useLibraryStore.getState().canOpenFolder).toBe(false)
    await useLibraryStore.getState().restore()
    expect(useLibraryStore.getState().canOpenFolder).toBe(true)
    expect(useLibraryStore.getState().canOpenFile).toBe(true)

    capability.can = false
    capability.canFile = false
    await useLibraryStore.getState().restore()
    expect(useLibraryStore.getState().canOpenFolder).toBe(false)
    expect(useLibraryStore.getState().canOpenFile).toBe(false)
  })

  // Absence is structural: on a browser without the pickers there is nothing to
  // restore, nothing to offer, and no folder entry in the sidebar at all.
  it('does nothing at boot on a browser that cannot pick directories', async () => {
    capability.can = false
    registry.restored = cad()
    await useLibraryStore.getState().restore()
    expect(useLibraryStore.getState().kind).toBe('browser')
    expect(useLibraryStore.getState().remembered).toBeNull()
  })

  it('reconnects at boot when the grant is still in force', async () => {
    registry.restored = cad()
    await useLibraryStore.getState().restore()
    expect(useLibraryStore.getState().kind).toBe('directory')
    expect(useLibraryStore.getState().label).toBe('cad')
    expect(activeLibrary().kind).toBe('directory')
  })

  // The usual case after a reload: the handle survived, the grant did not. The
  // folder becomes an entry to click, never a prompt nobody asked for.
  it('offers a remembered folder rather than prompting at boot', async () => {
    registry.name = 'cad'
    await useLibraryStore.getState().restore()
    expect(useLibraryStore.getState().kind).toBe('browser')
    expect(useLibraryStore.getState().remembered).toBe('cad')
  })

  // The degenerate case: one file is a library of one document. It is not
  // remembered across sessions the way a folder is -- there is no library to
  // come back to, only a document, and reopening it is one click of the picker.
  it('opens a picked file as a one-document library', async () => {
    picker.file = { name: 'Bracket.yaml' } as FileSystemFileHandle
    await useLibraryStore.getState().openFile()
    expect(useLibraryStore.getState().kind).toBe('file')
    expect(useLibraryStore.getState().label).toBe('Bracket')
    expect(activeLibrary().kind).toBe('file')
  })

  it('treats a cancelled file picker as a non-event', async () => {
    picker.file = null
    await useLibraryStore.getState().openFile()
    expect(useLibraryStore.getState().kind).toBe('browser')
    expect(useLibraryStore.getState().error).toBeNull()
  })

  it('opens a picked folder and remembers it', async () => {
    picker.result = cad()
    await useLibraryStore.getState().openFolder()
    expect(useLibraryStore.getState().kind).toBe('directory')
    expect(registry.remembered).toHaveLength(1)
  })

  it('treats a cancelled picker as a non-event', async () => {
    picker.result = null
    await useLibraryStore.getState().openFolder()
    expect(useLibraryStore.getState().kind).toBe('browser')
    expect(useLibraryStore.getState().error).toBeNull()
    expect(registry.remembered).toHaveLength(0)
  })

  it('surfaces a real picker failure without switching library', async () => {
    picker.error = new Error('picker exploded')
    await useLibraryStore.getState().openFolder()
    expect(useLibraryStore.getState().kind).toBe('browser')
    expect(useLibraryStore.getState().error).toMatch(/picker exploded/)
  })

  it('reopens a remembered folder on the user gesture', async () => {
    registry.name = 'cad'
    await useLibraryStore.getState().restore()
    registry.reopened = cad()
    await useLibraryStore.getState().reopenRemembered()
    expect(useLibraryStore.getState().kind).toBe('directory')
    expect(useLibraryStore.getState().remembered).toBeNull()
  })

  // A refused or vanished folder must not leave a dead entry in the sidebar,
  // and the user's browser-storage documents stay reachable throughout.
  it('drops the entry and stays on browser storage when the folder is gone', async () => {
    registry.name = 'cad'
    await useLibraryStore.getState().restore()
    registry.reopened = null
    await useLibraryStore.getState().reopenRemembered()
    expect(useLibraryStore.getState().kind).toBe('browser')
    expect(useLibraryStore.getState().remembered).toBeNull()
    expect(useLibraryStore.getState().error).toMatch(/no longer available/)
  })

  it('switches back to browser storage on request', async () => {
    picker.result = cad()
    await useLibraryStore.getState().openFolder()
    useLibraryStore.getState().useBrowserStorage()
    expect(useLibraryStore.getState().kind).toBe('browser')
    expect(activeLibrary().kind).toBe('browser')
  })

  // Closing forgets the folder so it does not come back next boot. Nothing on
  // disk is touched: the documents are the files, and they stay put.
  it('closing a folder forgets it', async () => {
    picker.result = cad()
    await useLibraryStore.getState().openFolder()
    await useLibraryStore.getState().closeFolder()
    expect(useLibraryStore.getState().kind).toBe('browser')
    expect(registry.forgotten).toBe(1)
  })

  // The pair must never be mixed: the folder's documents beside browser
  // storage's trash would delete into a library the user is not looking at.
  it('keeps the documents and trash faces of one library together', async () => {
    picker.result = cad()
    await useLibraryStore.getState().openFolder()
    const state = useLibraryStore.getState()
    expect(state.documents).toBe(activeLibrary().documents)
    expect(state.trash).toBe(activeLibrary().trash)
  })
})
