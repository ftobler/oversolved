import { EMPTY_ID, rgbToId } from './idEncoding'
import type { IdRegistry, IdRecord } from './IdRegistry'

/**
 * Walk a rectangular pixel buffer and collect every unique (layer, entityKey)
 * pair. Pixels with alpha=0 or EMPTY_ID are skipped. Unknown IDs are ignored.
 * Two distinct ids that decode to the same pair (a query collision when no UUID
 * backs the face) collapse to a single entry.
 *
 * `pixels` is a row-major RGBA Uint8Array (4 bytes per pixel). `width` / `height`
 * are the dimensions of the rectangle.
 *
 * Every pixel of that rectangle counts, unlike the cursor resolver, which keeps
 * only the disc inscribed in its window. The two are different affordances and
 * the difference is deliberate: a resolve is an aim at one point, so its reach
 * has to be the same in every direction, while a band is a region the user drew
 * and its corners are as much a part of it as its middle.
 */
export function collectEntitiesFromPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  registry: IdRegistry,
): { layer: string; entityKey: string }[] {
  const decoded = new Set<number>()  // pixel ids already looked up, skip re-decode
  const emitted = new Set<string>()  // (layer, entityKey) pairs already in `out`
  const out: { layer: string; entityKey: string }[] = []
  const pairKey = (layer: string, entityKey: string) => `${layer}\0${entityKey}`

  const take = (rec: { layer: string; entityKey: string }): void => {
    const pk = pairKey(rec.layer, rec.entityKey)
    if (emitted.has(pk)) return
    emitted.add(pk)
    out.push({ layer: rec.layer, entityKey: rec.entityKey })
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (pixels[i + 3] === 0) continue
      const id = rgbToId(pixels[i], pixels[i + 1], pixels[i + 2])
      if (id === EMPTY_ID) continue
      if (decoded.has(id)) continue
      decoded.add(id)
      const rec: IdRecord | undefined = registry.lookup(id)
      if (!rec) continue
      take(rec)
      // A mark that lost its pixel to a co-located one owns no pixel anywhere,
      // so a box would never see it by scanning. It is inside the box just the
      // same -- the mark that covered it is -- and the cursor resolver already
      // hands both back, so the two selection routes agree.
      for (const other of registry.coincidentMarkIds(id)) {
        if (other === id || decoded.has(other)) continue
        decoded.add(other)
        const co = registry.lookup(other)
        if (co) take(co)
      }
    }
  }

  return out
}
