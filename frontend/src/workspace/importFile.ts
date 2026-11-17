import { importBag, readZipBag, type ImportBag, type ImportResult } from './import'

// One file the user picked, adopted the way every import is: a zip or an
// `.oversolved` archive unpacks into its entries, anything else is a one-item
// bag the classifier sorts into a document, a STEP plus the part that imports
// it, or a plain file entry. `into` joins an open workspace; without it the
// file becomes a new one.
//
// The picker hands out no handle, so the picked bytes are read once and the
// source is forgotten: the entries are a plain copy and nothing links them back
// to the file.
export async function importPickedFile(file: File, opts: { into?: string } = {}): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const bag: ImportBag = /\.(zip|oversolved)$/i.test(file.name)
    ? await readZipBag(bytes)
    : { items: [{ path: file.name, bytes }] }
  return importBag(bag, opts.into !== undefined ? { into: opts.into } : {})
}
