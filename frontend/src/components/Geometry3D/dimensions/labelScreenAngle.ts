import * as THREE from 'three'
import { worldUnitsPerPixel } from '@/picking/screenSpaceScale'
import { readableLabelAngle } from '@/utils/geometry/dimensionRenderLayout'

// Screen facts for a linear dimension's value label. The text is a DOM overlay
// laid out by the browser in CSS pixels, so "parallel to the dimension line"
// and "how wide is the text" are screen questions: both are taken through the
// camera every frame. Only scalar results leave the module, so the caller can
// write them imperatively without a React state update per frame.
//
// The scratch vectors and the projected delta are module level on purpose:
// this runs in useFrame and must not allocate. A component's callback completes
// before the next starts, so the buffers cannot interleave.

const point1 = new THREE.Vector3()
const point2 = new THREE.Vector3()
const labelPoint = new THREE.Vector3()

// The last projection's CSS pixel delta, set by projectScreenDelta.
let screenDx = 0
let screenDy = 0

/** True when the camera carries the matrices project() needs. Headless tests
 *  and a not-yet-attached canvas pass camera stand-ins without them. */
function projectable(camera: THREE.Camera | undefined): camera is THREE.Camera {
  return !!camera?.projectionMatrix && !!camera.matrixWorldInverse
}

/**
 * Project d1 -> d2 into `screenDx`/`screenDy` (CSS pixel axes, y down), moved
 * into world space by the sketch plane's matrix first. False when the camera
 * cannot project, the viewport has no size, or either endpoint of a
 * perspective view sits at or behind the eye: there the divide mirrors the
 * point, so neither the direction nor the depth means anything.
 */
function projectScreenDelta(
  camera: THREE.Camera | undefined,
  width: number,
  height: number,
  plane: THREE.Matrix4,
  d1x: number, d1y: number, d2x: number, d2y: number,
): boolean {
  if (!projectable(camera) || !(width > 0) || !(height > 0)) return false
  point1.set(d1x, d1y, 0).applyMatrix4(plane)
  point2.set(d2x, d2y, 0).applyMatrix4(plane)
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    point1.applyMatrix4(camera.matrixWorldInverse)
    point2.applyMatrix4(camera.matrixWorldInverse)
    if (point1.z >= 0 || point2.z >= 0) return false
    point1.applyMatrix4(camera.projectionMatrix)
    point2.applyMatrix4(camera.projectionMatrix)
  } else {
    point1.project(camera)
    point2.project(camera)
  }
  // NDC x spans the viewport width, NDC y the height; the aspect ratio is what
  // makes a raw NDC angle wrong on a non-square canvas. CSS y grows downward.
  screenDx = ((point2.x - point1.x) * width) / 2
  screenDy = (-(point2.y - point1.y) * height) / 2
  return true
}

/**
 * The CSS `rotate()` angle, in degrees, that lays the label along d1 -> d2 for
 * the current camera, or null when the camera cannot project or the line is
 * not wholly in front of a perspective eye. The line is first moved into world
 * space by `plane` (the sketch plane's own matrix, the same one the scene group
 * and the ID registration use), then the pixel-space delta is folded to a
 * readable angle.
 */
export function linearLabelAngleDeg(
  camera: THREE.Camera | undefined,
  width: number,
  height: number,
  plane: THREE.Matrix4,
  d1x: number, d1y: number, d2x: number, d2y: number,
): number | null {
  if (!projectScreenDelta(camera, width, height, plane, d1x, d1y, d2x, d2y)) return null
  return readableLabelAngle(screenDx, screenDy)
}

/**
 * World units covered per CSS pixel measured ALONG the dimension line, i.e.
 * the factor that turns the rendered text width into a cut along the line.
 * The isotropic depth scale (linearLabelWorldPerPixel) is the wrong factor: a
 * line foreshortened by the view projects shorter, so each of its screen pixels
 * spans more world. Taken from the already projected endpoints,
 * `|d2 - d1| world / |d2 - d1| px`. 0 when the camera cannot project or the
 * line has no world length, which the caller reads as "no gap".
 */
export function linearLabelAlongWorldPerPixel(
  camera: THREE.Camera | undefined,
  width: number,
  height: number,
  plane: THREE.Matrix4,
  d1x: number, d1y: number, d2x: number, d2y: number,
): number {
  const worldLen = Math.hypot(d2x - d1x, d2y - d1y)
  if (!(worldLen > 0)) return 0
  if (!projectScreenDelta(camera, width, height, plane, d1x, d1y, d2x, d2y)) return 0
  const screenLen = Math.hypot(screenDx, screenDy)
  return screenLen > 0 ? worldLen / screenLen : 0
}

/**
 * World units spanned by one CSS pixel at the label's position, isotropic in
 * the view plane. Used for the "is the label on the line" tolerance (about
 * half the rendered text height), not for the along-line gap; see
 * linearLabelAlongWorldPerPixel. 0 when the camera cannot project or the label
 * is at or behind a perspective eye.
 */
export function linearLabelWorldPerPixel(
  camera: THREE.Camera | undefined,
  height: number,
  plane: THREE.Matrix4,
  x: number, y: number,
): number {
  if (!projectable(camera) || !(height > 0)) return 0
  const projectionY = camera.projectionMatrix.elements[5]
  // Under perspective one pixel's world size depends on depth; under the
  // viewport's orthographic camera clip-space w is 1, the same reduction
  // worldUnitsPerPixel documents for p2w.
  let clipW = 1
  if (!(camera as THREE.OrthographicCamera).isOrthographicCamera) {
    if (!(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return 0
    const viewZ = labelPoint.set(x, y, 0).applyMatrix4(plane).applyMatrix4(camera.matrixWorldInverse).z
    clipW = -viewZ
    if (!(clipW > 0)) return 0
  }
  return worldUnitsPerPixel(projectionY, height, clipW)
}
