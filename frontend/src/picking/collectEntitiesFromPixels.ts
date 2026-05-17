import { EMPTY_ID, rgbToId } from './idEncoding'
import type { IdRegistry, IdRecord } from './IdRegistry'

/**
 * Walk a rectangular pixel buffer and collect every unique (layer, entityKey)
 * pair. Pixels with alpha=0 or EMPTY_ID are skipped. Unknown IDs are ignored.
 *
 * `pixels` is a row-major RGBA Uint8Array (4 bytes per pixel). `width` / `height`
 * are the dimensions of the rectangle.
 */
export function collectEntitiesFromPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  registry: IdRegistry,
): { layer: string; entityKey: string }[] {
  const seen = new Set<number>()
  const out: { layer: string; entityKey: string }[] = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (pixels[i + 3] === 0) continue
      const id = rgbToId(pixels[i], pixels[i + 1], pixels[i + 2])
      if (id === EMPTY_ID) continue
      if (seen.has(id)) continue
      seen.add(id)
      const rec: IdRecord | undefined = registry.lookup(id)
      if (rec) out.push({ layer: rec.layer, entityKey: rec.entityKey })
    }
  }

  return out
}
