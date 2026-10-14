/**
 * Screen-space sizing math shared by the ID (pick) pass.
 *
 * Pure so the sizing rule can be unit tested without a WebGL context; the
 * GLSL in VertexIdLayer implements the identical formula per vertex, because
 * under a perspective camera the world size of one pixel depends on the
 * vertex's own view depth and cannot be a single per-frame CPU constant.
 */

/**
 * Edge of the square pick window, in CSS pixels; the reach it stands for is the
 * radius of the disc inscribed in it, 8 px around the cursor.
 *
 * CSS and not device pixels, because the two diverge on every HiDPI display and
 * only one of them is the affordance. The ID target is allocated at
 * drawing-buffer resolution (`IdPickingDriver`'s `getDrawingBufferSize`) and the
 * cursor is converted into those same device pixels, so a window taken
 * literally as device pixels shrinks to 8/DPR CSS pixels. That matters most for
 * the helper vertex layers -- sketch vertices, the origin marker, dimension
 * labels -- which each mark a single point (`VertexIdLayer`'s points path), so
 * the window is not a tolerance around their footprint, it IS their whole catch
 * radius. At DPR 2 that radius lands at 4 CSS px, inside the 5 px radius of the
 * dot a sketch point draws, so the user aims at a dot whose own rim is out of
 * range. A sketch entity nearby keeps answering not because it is drawn fat --
 * `EdgeIdLayer` rasterises 1 px lines too -- but because a curve marks a
 * contiguous RUN of pixels, so it is far likelier than an isolated dot to have
 * one of them inside a shrunken window. `getEffectiveWindowSize` scales this
 * back into device pixels at read time.
 *
 * Lives here rather than on IdPipeline so the pure scene probe can read the
 * same radius without importing the three.js pipeline; IdPipeline re-exports it
 * for the existing import sites.
 */
export const DEFAULT_WINDOW_SIZE = 17

/**
 * Pick reach in pixels: the radius of the disc inscribed in the square window.
 * The one derivation of "how far a pick reaches", shared by the pipeline's
 * read window and the probe's candidate filter.
 */
export function pickRadiusPx(windowSize: number = DEFAULT_WINDOW_SIZE): number {
  return (windowSize - 1) / 2
}

/**
 * World units spanned by one screen pixel, at the depth whose clip-space `w`
 * is `clipW`.
 *
 * `projectionY` is `projectionMatrix.elements[5]` (the matrix' Y scale):
 * `1 / tan(fov / 2)` for perspective, `2 / (top - bottom)` for orthographic.
 * `clipW` is `-viewZ` under perspective and exactly 1 under orthographic,
 * which is what makes one formula cover both projections.
 *
 * For an R3F orthographic camera (frustum height = canvas height / zoom) this
 * reduces to `1 / zoom`, i.e. it agrees with `p2w()` in sketchHelpers.
 */
export function worldUnitsPerPixel(projectionY: number, viewportHeight: number, clipW: number): number {
  const h = Math.max(viewportHeight, 1)
  if (!Number.isFinite(projectionY) || projectionY === 0) return 0
  return (2 * clipW) / (projectionY * h)
}

/**
 * Half the world-space edge length of a cube that covers `pixels` screen
 * pixels on a side. The pick-pass vertex cube offsets its 8 corners by this
 * amount along each view axis, which also gives it `pixels` worth of depth
 * extent so the depth buffer alone can rank it above the face it sits on.
 */
export function pixelCubeHalfExtent(
  pixels: number,
  projectionY: number,
  viewportHeight: number,
  clipW: number,
): number {
  return (pixels / 2) * worldUnitsPerPixel(projectionY, viewportHeight, clipW)
}

/** The 8 corners of a unit cube in {-1, +1}^3, ordered by bit pattern (x,y,z). */
export const CUBE_CORNER_SIGNS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, -1], [+1, -1, -1], [-1, +1, -1], [+1, +1, -1],
  [-1, -1, +1], [+1, -1, +1], [-1, +1, +1], [+1, +1, +1],
]

/** Triangle indices into CUBE_CORNER_SIGNS for the 12 triangles of the cube. */
export const CUBE_TRIANGLE_INDICES: ReadonlyArray<number> = [
  0, 2, 3, 0, 3, 1,  // -z
  4, 5, 7, 4, 7, 6,  // +z
  0, 1, 5, 0, 5, 4,  // -y
  2, 6, 7, 2, 7, 3,  // +y
  0, 4, 6, 0, 6, 2,  // -x
  1, 3, 7, 1, 7, 5,  // +x
]
