/**
 * Convert a screen-pixel width to clip-space units along X and Y for a
 * given viewport resolution.
 *
 * NDC ranges from -1..+1, so 1 pixel = 2 / dimension clip-space units.
 * Returned as a tuple [dxClip, dyClip] for the X and Y axes respectively.
 *
 * Used by the edge ribbon and vertex quad shaders to fatten geometry to
 * a constant pixel width regardless of camera zoom.
 */
export function pixelsToClipSpace(pixels: number, viewportWidth: number, viewportHeight: number): [number, number] {
  const w = Math.max(1, viewportWidth)
  const h = Math.max(1, viewportHeight)
  return [(2 * pixels) / w, (2 * pixels) / h]
}
