import { getPreviewStore } from './index'
import { previewKey } from './types'

// The preview writes that are not a save. Each rides a path the user never
// asked a thumbnail from -- a document's first successful solve, an adoption, a
// clone -- so all are best-effort: no GL context (a headless test), a lost
// context or a blocked database must cost the caller nothing and can never
// surface an error or block the path it rides on. Nothing here touches the
// document, so a capture can never mark it dirty.
//
// The key is the save path's, `(workspace ?? entry, entry)`, so a solve, a save
// and a tile read all address the same record.

export async function writePreview(
  workspace: string | undefined, entry: string, image: string,
): Promise<void> {
  try {
    await getPreviewStore().put(workspace ?? entry, entry, image)
  } catch {
    // A preview is derived data: losing one costs a re-render, never a document.
  }
}

// The first-solve capture. `capture` is the viewport's
// `captureScreenshotForSaving`, absent whenever no viewport is mounted; a null
// return (no GL context yet) is a miss, not a failure.
//
// A saved preview is the user's: it shows the view they left the document in.
// Opening a document must not replace it with whatever the first solve happens
// to see, so the capture only fills an empty key.
export async function capturePreview(
  capture: (() => Promise<string | null>) | undefined,
  workspace: string | undefined,
  entry: string,
): Promise<void> {
  if (!capture) return
  try {
    if (await getPreviewStore().get(workspace ?? entry, entry) !== undefined) return
  } catch {
    // An unreadable store cannot answer "is there one already"; skip the write
    // rather than risk replacing a preview we could not see.
    return
  }
  let dataUrl: string | null = null
  try {
    dataUrl = await capture()
  } catch {
    return
  }
  const image = dataUrl?.split(',')[1]
  if (!image) return
  try {
    // The read above spares the capture; this is the race-free half. A save
    // that wrote a preview while this one was rendering keeps it.
    await getPreviewStore().putIfAbsent(workspace ?? entry, entry, image)
  } catch {
    // A preview is derived data: losing one costs a re-render, never a document.
  }
}

// A copy of an entry's preview, for the operations that mint a new entry from
// an existing one (a document clone, a whole-workspace duplicate). The copy is
// a statement about what the new row looks like, not about the document, so it
// is derived data like every other preview: best-effort, and a failure leaves a
// placeholder rather than failing the copy the user asked for.
export async function copyPreview(
  fromWorkspace: string, fromEntry: string,
  toWorkspace: string, toEntry: string,
): Promise<void> {
  try {
    const image = await getPreviewStore().get(fromWorkspace, fromEntry)
    if (image !== undefined) await getPreviewStore().put(toWorkspace, toEntry, image)
  } catch {
    // See above.
  }
}

// The whole-workspace form, keyed by the id map `remapTree` returned from old
// entry ids to the new ones. One batch read and one batch write, both
// best-effort: a failed batch leaves every copied row on its placeholder; it
// never fails the duplicate, which has already written its documents.
export async function copyWorkspacePreviews(
  fromWorkspace: string,
  toWorkspace: string,
  idMap: ReadonlyMap<string, string>,
): Promise<void> {
  if (idMap.size === 0) return
  try {
    const images = await getPreviewStore().getMany(
      [...idMap.keys()].map(entry => ({ workspace: fromWorkspace, entry })),
    )
    const records: Array<{ workspace: string; entry: string; image: string }> = []
    for (const [fromEntry, toEntry] of idMap) {
      const image = images.get(previewKey(fromWorkspace, fromEntry))
      if (image !== undefined) records.push({ workspace: toWorkspace, entry: toEntry, image })
    }
    await getPreviewStore().putMany(records)
  } catch {
    // A preview copy is decoration: the duplicate itself already succeeded.
  }
}

// Adoption's sidecar bytes. The bag carries a raw PNG and the store holds base64
// with no `data:` prefix, so the encode belongs here. Chunked, because spreading
// a whole file into String.fromCharCode overflows the call stack on anything but
// a tiny image.
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
