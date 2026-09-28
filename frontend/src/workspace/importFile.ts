import { importBag, readZipBag, type ImportBag, type ImportResult } from './import'
import { getOriginResolver, mintOriginLocator, type OriginDescriptor } from './originResolver'

// One file the user picked, adopted the way every import is: a zip or an
// `.oversolved` archive unpacks into its entries, anything else is a one-item
// bag the classifier sorts into a document, a STEP plus the part that imports
// it, or a plain file entry. `into` joins an open workspace; without it the
// file becomes a new one.
//
// The picked bytes are captured once and registered as a same-session origin,
// so the rows it lands can name their source and an explicit update can re-read
// it without asking for the file again. The picker hands out no handle, so the
// origin does not outlive the session.
export async function importPickedFile(file: File, opts: { into?: string } = {}): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const locator = mintOriginLocator('file')
  const isArchive = /\.(zip|oversolved)$/i.test(file.name)
  const read = async (): Promise<ImportBag> => isArchive
    ? readZipBag(bytes, locator)
    : { origin: locator, items: [{ path: file.name, bytes }] }
  const descriptor: OriginDescriptor = { locator, name: file.name, read }
  getOriginResolver().register(descriptor)
  return importBag(await read(), { origin: descriptor, ...(opts.into !== undefined ? { into: opts.into } : {}) })
}
