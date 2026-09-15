import JSZip from 'jszip'
import type { SerializedFile, WorkspaceTree } from './types'
import { deserializeTree, serializeTree } from './serializer'

// The archive endpoint: a whole tree to bytes, and bytes back to a whole tree.
// It writes exactly what the folder writer writes -- the same serializeTree
// layout -- so unzipping an archive into a folder and reading that folder
// yields the same tree.
//
// I4 pins every metadata field JSZip would otherwise fill from the clock or the
// platform: STORE compression, a fixed 1980-01-01 date, fixed permissions, a
// fixed insertion order (serializeTree's), no implicit directory entries, and
// no comment. Two writes of one tree are therefore byte-equal.
//
// I7 holds by construction: an archive is built in one generateAsync call, so
// there is no partial zip to leave behind.

const FIXED_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0))

interface FileOptions {
  compression: 'STORE'
  date: Date
  unixPermissions: number
  dosPermissions: number
  createFolders: boolean
  comment: string
}

const FILE_OPTS: FileOptions = {
  compression: 'STORE',
  date: FIXED_DATE,
  unixPermissions: 0o644,
  dosPermissions: 0,
  createFolders: false,
  comment: '',
}

// The raw archive. Pure over the tree, so it is testable without a handle and
// is itself the export payload.
export async function buildZipBytes(tree: WorkspaceTree): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const file of serializeTree(tree)) zip.file(file.path, file.data, FILE_OPTS)
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'STORE',
    platform: 'DOS',
    streamFiles: false,
    comment: '',
    mimeType: 'application/zip',
  })
}

// Every entry of an archive, as serializeTree's shape, in the archive's order.
export async function readZipFiles(bytes: Uint8Array): Promise<SerializedFile[]> {
  const zip = await JSZip.loadAsync(bytes)
  const out: SerializedFile[] = []
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue
    out.push({ path: name, data: await zip.files[name].async('uint8array') })
  }
  return out
}

// An archive read whole. A fresh deserialize per call, so the tree that comes
// back can never alias anything the caller holds.
export async function readZipTree(bytes: Uint8Array): Promise<WorkspaceTree> {
  return deserializeTree(await readZipFiles(bytes))
}
