// The parts of the File System Access API TypeScript's lib.dom does not declare.
//
// lib.dom covers the handle interfaces themselves (FileSystemDirectoryHandle,
// FileSystemFileHandle, FileSystemWritableFileStream) because OPFS reaches them
// through `navigator.storage.getDirectory()`, which every engine ships. What it
// omits is exactly the Chromium-only surface: the pickers that let a USER
// choose a real directory, the async iteration of a directory's entries, and
// the permission handshake a persisted handle needs after a reload.
//
// Declaring them does not make them exist. Every call site must still ask the
// capability module (adapters/fileSystemAccess.ts) first; these declarations
// only stop the optional-chaining checks from being written against `any`, and
// they cover exactly the surface this app calls: a picker or an iterator that
// nothing uses is a declaration that cannot go stale where anyone would notice.

interface FileSystemHandle {
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>
}

interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

interface OpenFilePickerOptions {
  id?: string
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: FilePickerAcceptType[]
}

interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
}

interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>
}
