// The File System Access capability: one module answering "can this browser
// hand the app a real folder", so no view ever sniffs `window` for itself.
//
// The pickers are Chromium-only. Firefox and Safari implement OPFS
// (`navigator.storage.getDirectory()`) but not `showDirectoryPicker`, and OPFS
// is not a substitute -- it is a private origin-scoped filesystem the user
// cannot see, back up or put in git, which is the entire point of this feature.
// So the promise is deliberate and asymmetric: Chromium gets open/save in
// place, every other browser keeps today's download/upload, and the affordance
// is ABSENT rather than present-and-broken. Absence is structural here, the
// same way the backend removal treated missing capabilities.
//
// This mirrors the shape the deleted `config/capabilities.ts` had, without
// reintroducing a build-time flag: the answers below are read off the live
// platform, so one build serves every browser.

// A user cancelling a picker is not an error. The API signals it with an
// AbortError DOMException, which every wrapper here folds into `null` so call
// sites branch on a value instead of catching to detect a non-event.
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

export function canPickDirectory(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

// The "Open archive" gesture's gate. Chromium can hand back a file handle, so
// the import menu offers the picker there; elsewhere an archive is still
// importable through the plain file input. The same capability as the directory
// picker.
export function canPickWorkspaceZip(): boolean {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'
}

const WORKSPACE_ZIP_PICKER_ID = 'oversolved-workspace-zip'

// Returns null when the browser cannot pick or the user cancelled. Must be
// called from a user gesture. The archive is an import source only: its bytes
// are read by the caller and never written.
export async function pickWorkspaceZip(): Promise<FileSystemFileHandle | null> {
  if (!canPickWorkspaceZip()) return null
  try {
    const handles = await window.showOpenFilePicker!({
      id: WORKSPACE_ZIP_PICKER_ID,
      multiple: false,
      types: [{
        description: 'Oversolved workspace archive',
        accept: { 'application/zip': ['.zip', '.oversolved'] },
      }],
    })
    return handles[0] ?? null
  } catch (err) {
    if (isAbort(err)) return null
    throw err
  }
}

// `id` pins the picker's remembered starting directory. Single-file picking was
// the in-place single-file library's gesture and retired with it: a file is now
// a source a workspace adopts, never a library the app saves back to.
const LIBRARY_PICKER_ID = 'oversolved-library'

// Returns null when the browser cannot pick or the user cancelled. Must be
// called from a user gesture: the picker rejects with a SecurityError
// otherwise, which is a programming error here, not a runtime condition, so it
// is left to propagate.
export async function pickLibraryDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!canPickDirectory()) return null
  try {
    return await window.showDirectoryPicker!({ id: LIBRARY_PICKER_ID, mode: 'readwrite' })
  } catch (err) {
    if (isAbort(err)) return null
    throw err
  }
}
