/**
 * 24-bit entity ID <-> RGB packing for the off-screen ID render target.
 *
 * Alpha is reserved as the "occupied" channel: A=255 means a layer wrote
 * something here, A=0 means empty space. RGB carries the 24-bit ID.
 *
 * Layout: R = (id >> 16) & 0xFF, G = (id >> 8) & 0xFF, B = id & 0xFF.
 */

export const EMPTY_ID = 0
export const MAX_ID = 0xFFFFFF

export function idToRGB(id: number): [number, number, number] {
  if (id < 0 || id > MAX_ID || !Number.isInteger(id)) {
    throw new Error(`idToRGB: id ${id} out of 24-bit range`)
  }
  return [(id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF]
}

export function rgbToId(r: number, g: number, b: number): number {
  return ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF)
}

/** Normalized [0,1] floats for use as a fragment-shader uniform. */
export function idToRGBNormalized(id: number): [number, number, number] {
  const [r, g, b] = idToRGB(id)
  return [r / 255, g / 255, b / 255]
}
