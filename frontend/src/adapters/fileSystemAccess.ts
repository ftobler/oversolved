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

export function canPickFiles(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.showOpenFilePicker === 'function' &&
    typeof window.showSaveFilePicker === 'function'
}

// Documents written by this app. One extension, because one document is one
// file: the on-disk unit is the same YAML the export button already produces.
const DOCUMENT_TYPES: FilePickerAcceptType[] = [
  { description: 'Oversolved document', accept: { 'text/yaml': ['.yaml', '.yml'] } },
]

// `id` pins the picker's remembered starting directory per purpose, so opening
// a library and saving a single document do not drag each other's last folder
// around.
const LIBRARY_PICKER_ID = 'oversolved-library'
const DOCUMENT_PICKER_ID = 'oversolved-document'

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

export async function pickDocumentToOpen(): Promise<FileSystemFileHandle | null> {
  if (!canPickFiles()) return null
  try {
    const [handle] = await window.showOpenFilePicker!({
      id: DOCUMENT_PICKER_ID, multiple: false, types: DOCUMENT_TYPES,
    })
    return handle ?? null
  } catch (err) {
    if (isAbort(err)) return null
    throw err
  }
}

export async function pickDocumentToSave(suggestedName: string): Promise<FileSystemFileHandle | null> {
  if (!canPickFiles()) return null
  try {
    return await window.showSaveFilePicker!({
      id: DOCUMENT_PICKER_ID, suggestedName, types: DOCUMENT_TYPES,
    })
  } catch (err) {
    if (isAbort(err)) return null
    throw err
  }
}

// The re-permission handshake a handle needs after a reload. A handle survives
// in IndexedDB across sessions, but the GRANT does not: the browser drops it
// when the tab closes, so a restored handle answers 'prompt' until the user
// re-confirms. `request` must be false outside a user gesture (a boot-time
// probe) and true inside one (the click that reopens the library), because
// requestPermission throws without a gesture.
// Typed to the two methods it actually calls rather than to FileSystemHandle:
// the permission surface is the Chromium-only part, and a caller holding a
// handle from anywhere (a picker, a restored IndexedDB record) should not have
// to satisfy the full platform interface to ask this question.
export interface PermissionedHandle {
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}

export async function hasReadWritePermission(
  handle: PermissionedHandle,
  { request }: { request: boolean },
): Promise<boolean> {
  const descriptor = { mode: 'readwrite' as const }
  try {
    const current = await handle.queryPermission?.(descriptor)
    // An engine without queryPermission (OPFS-only handles, and the spec's own
    // baseline) grants implicitly; treat undefined as already permitted rather
    // than locking the store out of a directory it can in fact write.
    if (current === undefined || current === 'granted') return true
    if (!request || current === 'denied') return false
    return (await handle.requestPermission?.(descriptor)) === 'granted'
  } catch {
    // A revoked or vanished directory throws here. Not having permission and
    // failing to ask for it are the same answer to the caller.
    return false
  }
}
