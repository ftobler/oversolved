import { getPreviewStore } from './index'

// The preview writes that are not a save. Both ride a path the user never asked
// a thumbnail from -- a document's first successful solve, an adoption -- so
// both are best-effort: no GL context (a headless test), a lost context or a
// blocked database must cost the caller nothing and can never surface an error
// or block the path it rides on. Nothing here touches the document, so a
// capture can never mark it dirty.
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
export async function capturePreview(
  capture: (() => Promise<string | null>) | undefined,
  workspace: string | undefined,
  entry: string,
): Promise<void> {
  if (!capture) return
  let dataUrl: string | null = null
  try {
    dataUrl = await capture()
  } catch {
    return
  }
  const image = dataUrl?.split(',')[1]
  if (!image) return
  await writePreview(workspace, entry, image)
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
