import { create } from 'zustand'
import {
  setActiveLibrary, activeLibrary, browserLibraryTarget, type LibraryKind,
} from '@/adapters/library'
import type { DocumentStore, TrashAdapter } from '@/stores/documentStore'
import { openDirectoryLibrary } from '@/stores/documentStore/FileSystemDirectoryStore'
import { openSingleFileLibrary } from '@/stores/documentStore/singleFileLibrary'
import {
  rememberLibraryHandle, restoreLibraryHandle, reopenLibraryHandle,
  rememberedLibraryName, forgetLibraryHandle,
} from '@/stores/documentStore/libraryHandleRegistry'
import {
  canPickDirectory, canPickFiles, pickLibraryDirectory, pickDocumentToOpen,
} from '@/adapters/fileSystemAccess'
import { errorMessage } from '@/utils/core/errorMessage'

// Which library the user is looking at, as UI state.
//
// The switch itself is one call into adapters/library, and every consumer keeps
// reading the same forwarding store off backendBundle. This store exists for
// the two things that forwarding object deliberately cannot do: let the sidebar
// render which library is live, and let the documents grid notice a switch.
//
// It therefore carries the live `documents` / `trash` pair as state as well.
// The grid reads its store from here rather than from the bundle, so switching
// library changes a value its fetch callback genuinely depends on and the
// refetch falls out of the normal hook rules -- no revision counter, and no
// dependency the linter has to be told to ignore.

interface LibraryState {
  kind: LibraryKind
  label: string
  documents: DocumentStore
  trash: TrashAdapter
  // A folder handle is remembered but its permission grant lapsed with the last
  // tab. Named so the sidebar can offer to reopen THAT folder rather than a
  // generic "open a folder", which is a materially different click.
  remembered: string | null
  canOpenFolder: boolean
  canOpenFile: boolean
  error: string | null
  restore: () => Promise<void>
  openFolder: () => Promise<void>
  openFile: () => Promise<void>
  reopenRemembered: () => Promise<void>
  useBrowserStorage: () => Promise<void>
  closeFolder: () => Promise<void>
  clearError: () => void
}

export const useLibraryStore = create<LibraryState>((set, get) => {
  // Every switch goes through here, so the forwarding target and the state the
  // views read can never disagree about which library is live.
  const activate = (
    kind: LibraryKind, label: string,
    ports: { documents: DocumentStore; trash: TrashAdapter },
  ): void => {
    setActiveLibrary({ kind, label, ...ports })
    set({ kind, label, documents: ports.documents, trash: ports.trash, error: null })
  }

  const toBrowser = (): void => {
    const target = browserLibraryTarget()
    activate(target.kind, target.label, { documents: target.documents, trash: target.trash })
  }

  const toDirectory = (dir: FileSystemDirectoryHandle): void => {
    const { documents, trash } = openDirectoryLibrary(dir)
    activate('directory', dir.name, { documents, trash })
  }

  // The degenerate case: a library of exactly one document, which is the file
  // the user picked. Not remembered across sessions, unlike a folder -- there
  // is no library to come back to, only a document, and reopening it is one
  // click of the same picker.
  const toFile = (file: FileSystemFileHandle): void => {
    const { documents, trash, label } = openSingleFileLibrary(file)
    activate('file', label, { documents, trash })
  }

  return {
    // Browser storage is the boot state and the fallback, set as the live
    // target in adapters/backend before any of this runs.
    kind: activeLibrary().kind,
    label: activeLibrary().label,
    documents: activeLibrary().documents,
    trash: activeLibrary().trash,
    remembered: null,
    // Answered by `restore()` rather than at module load. The value cannot
    // change at runtime, but reading the platform while this module is still
    // evaluating makes the answer depend on import order, which is how a
    // capability check turns into a heisenbug.
    canOpenFolder: false,
    canOpenFile: false,
    error: null,

    // Boot. Runs outside a user gesture, so it may probe an existing grant but
    // must never prompt: a remembered folder whose grant lapsed surfaces as an
    // entry to click, not as a permission dialog nobody asked for.
    restore: async () => {
      const canOpenFolder = canPickDirectory()
      set({ canOpenFolder, canOpenFile: canPickFiles() })
      if (!canOpenFolder) return
      const handle = await restoreLibraryHandle()
      if (handle) {
        toDirectory(handle)
        return
      }
      set({ remembered: await rememberedLibraryName() })
    },

    openFolder: async () => {
      try {
        const dir = await pickLibraryDirectory()
        if (!dir) return  // cancelled: a non-event
        await rememberLibraryHandle(dir)
        toDirectory(dir)
        set({ remembered: null })
      } catch (e) {
        set({ error: errorMessage(e, 'Failed to open folder') })
      }
    },

    openFile: async () => {
      try {
        const file = await pickDocumentToOpen()
        if (!file) return  // cancelled: a non-event
        toFile(file)
      } catch (e) {
        set({ error: errorMessage(e, 'Failed to open file') })
      }
    },

    reopenRemembered: async () => {
      try {
        const handle = await reopenLibraryHandle()
        if (!handle) {
          // Refused, revoked or gone. The registry has forgotten it, so the
          // entry goes with it and browser storage stands.
          set({ remembered: null, error: 'That folder is no longer available' })
          return
        }
        toDirectory(handle)
        set({ remembered: null })
      } catch (e) {
        set({ error: errorMessage(e, 'Failed to reopen folder') })
      }
    },

    useBrowserStorage: async () => {
      if (get().kind === 'browser') return
      toBrowser()
      // The folder is still remembered, so it has to reappear as an entry to
      // click. Without this it silently vanishes from the sidebar until a
      // reload, which reads as "switching away lost my folder".
      set({ remembered: await rememberedLibraryName() })
    },

    // Stops using whatever is open. A FOLDER is also forgotten, so it does not
    // come back next boot; a single FILE is not, because closing a file the
    // user opened on top of their folder must not throw the folder away.
    // Nothing on disk is touched either way: the documents are the files, and
    // they stay exactly where the user put them.
    closeFolder: async () => {
      const wasDirectory = get().kind === 'directory'
      if (wasDirectory) await forgetLibraryHandle()
      toBrowser()
      set({ remembered: wasDirectory ? null : await rememberedLibraryName() })
    },

    clearError: () => set({ error: null }),
  }
})
