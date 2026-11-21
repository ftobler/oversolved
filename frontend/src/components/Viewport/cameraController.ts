import * as THREE from 'three'
import type { PartResult, PlaneTransform } from '@/types/cad'
import { computeVertexBounds } from '@/utils/geometry/vertexBounds'
import { INITIAL_ZOOM } from './cameraConstants'
import type { TurntableControls } from './turntable'
import { anglesFromDirection, orbitDirection, rolledBasis, orbitUp } from './turntable'

// How much of the viewport the framed content fills: targetViewHeight =
// contentHeight * FIT_MARGIN, so content occupies 1/FIT_MARGIN of the frustum.
// Higher means more breathing room (zoomed out further). This is the single
// knob for "how tight is zoom-to-fit" - it is the only thing that decides
// framing now that fit-to-content is the one camera-framing path (the old
// fixed-pose Reset Viewport is gone).
const FIT_MARGIN = 2.5

// ─── clip planes ───
// near/far are sized to the content, not fixed, because the depth range is not
// free: for an ortho camera the depth-buffer resolution unit is proportional to
// (far - near), and Part3D pushes faces back by polygonOffsetUnits=1 of exactly
// that unit to keep edges off their own faces. A range big enough for the worst
// case therefore turns that offset into a visible penetration depth and makes
// small parts look transparent (their back faces beat the offset front faces).
// Sizing to the content keeps the offset imperceptible at every scale.
//
// The pad is what the view may gain after the fit without clipping: the camera
// can still orbit (an AABB measured along one axis grows by up to sqrt(3) when
// turned) and geometry can still be added. Two extents of slack on each side
// covers both, and reproduces the historical ~1000-unit range for small models.
const CLIP_PAD_FACTOR = 2
const MIN_CLIP_PAD = 500

// ─── camera chokepoint ───
// Every programmatic camera move in the viewport goes through this module.
// The camera itself is otherwise only touched by the user (TurntableControls) and
// created once by the <Canvas>. Having a single set of writers means one place
// answers "what moved the camera, and why" - flip CAMERA_TRACE to true to
// follow every move with its trigger source, which is what makes
// hard-to-reproduce viewport bugs traceable instead of a needle in a haystack.
const CAMERA_TRACE = false

export function traceCamera(op: string, ...detail: unknown[]): void {
  if (CAMERA_TRACE) console.log(`[camera] ${op}`, ...detail)
}

type Controls = TurntableControls | null

// updateProjectionMatrix lives on the camera subclasses (Ortho/Perspective),
// not the THREE.Camera base type. Our camera is always one of those, but the
// base-camera tests and probe helpers can hand in the base type.
function commitProjection(camera: THREE.Camera): void {
  const cam = camera as THREE.Camera & { updateProjectionMatrix?: () => void }
  cam.updateProjectionMatrix?.()
}

function readZoom(camera: THREE.Camera): number {
  return 'zoom' in camera ? (camera as unknown as { zoom: number }).zoom : INITIAL_ZOOM
}

// Point the camera at a known direction (target -> camera) from a known target,
// keeping the controller's state and the camera in lockstep. The fallback is
// only for callers without a controller (the unit tests of this module): it
// positions the camera directly and leaves the roll to lookAt.
function pointCamera(
  camera: THREE.Camera,
  controls: Controls,
  direction: THREE.Vector3,
  distance: number,
  target: THREE.Vector3,
  poleAzimuth: number,
): void {
  if (controls) {
    controls.setDirection(direction, { distance, target, poleAzimuth })
    return
  }
  const dir = direction.clone().normalize()
  camera.position.copy(target).addScaledVector(dir, distance)
  camera.lookAt(target)
  commitProjection(camera)
}

// Rotate to look down the given direction (gizmo face/edge/corner click),
// preserving the current distance from the origin.
export function snapToDirection(camera: THREE.Camera, controls: Controls, dir: THREE.Vector3): void {
  traceCamera('snapToDirection', 'dir=', dir.toArray())
  snapView(camera, controls, dir, camera.position.length(), new THREE.Vector3())
}

// Turn the view about the camera's own axis (the cube's roll arrows), keeping
// where it looks from. Positive turns the scene clockwise on screen, the same
// sense as TurntableControls.rollBy; the controller-less fallback is the
// matching local Z turn, since the camera looks down its -Z.
export function rollView(camera: THREE.Camera, controls: Controls, angle: number): void {
  traceCamera('rollView', 'angle=', angle)
  if (controls) {
    controls.rollBy(angle)
    return
  }
  camera.rotateZ(angle)
  camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion)
  camera.updateMatrixWorld()
}

// Swing the camera round its target by `angle` toward a screen direction (the
// cube's orbit triangles): (1, 0) moves it right, (0, 1) up over the model.
// The controller-less fallback turns about the origin, the fallback target
// pointCamera also assumes.
export function orbitView(camera: THREE.Camera, controls: Controls, right: number, up: number, angle: number): void {
  traceCamera('orbitView', 'right=', right, 'up=', up, 'angle=', angle)
  if (controls) {
    controls.orbitStep(right, up, angle)
    return
  }
  const length = Math.hypot(right, up)
  if (length === 0) return
  // Camera-space axis that carries the view direction (+Z) toward (right, up).
  const axis = new THREE.Vector3(-up / length, right / length, 0).applyQuaternion(camera.quaternion)
  const turn = new THREE.Quaternion().setFromAxisAngle(axis, angle)
  camera.position.applyQuaternion(turn)
  camera.quaternion.premultiply(turn)
  camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion)
  camera.updateMatrixWorld()
}

// The turntable azimuth whose straight-up (normalY > 0) or straight-down view
// has screen up along `yAxis`. On a pole the orbit law gives up = (-sin a, 0,
// -cos a) looking down and (sin a, 0, cos a) looking up, solved here for a.
export function poleAzimuthForUp(yAxis: [number, number, number], normalY: number): number {
  const [x, , z] = yAxis
  return normalY >= 0 ? Math.atan2(-x, -z) : Math.atan2(x, z)
}

// Pure helper: pick the nearest 90-degree roll mark for a view direction. Given
// the camera's screen up before the move and the target view direction (face or
// plane normal, camera side), returns the turntable pose of the closest mark.
// No camera or controls: only angles and a basis. The pole case (|d.y| = 1
// within the turntable's pole test) snaps the azimuth to the nearest cardinal
// mark with roll 0; the off-pole case keeps the turntable angles and snaps the
// roll to the nearest quarter turn.
export function nearestSquareRoll(
  currentUp: THREE.Vector3 | readonly [number, number, number],
  direction: THREE.Vector3 | readonly [number, number, number],
): { azimuth: number; elevation: number; roll: number } {
  const toVec = (v: THREE.Vector3 | readonly [number, number, number]): THREE.Vector3 =>
    v instanceof THREE.Vector3 ? v.clone() : new THREE.Vector3(v[0], v[1], v[2])

  const d = toVec(direction)
  const length = d.length()
  if (!(length > 0)) return { azimuth: 0, elevation: 0, roll: 0 }
  d.divideScalar(length)

  const upIn = toVec(currentUp)
  const projected = upIn.clone().sub(d.clone().multiplyScalar(upIn.dot(d)))
  // A degenerate projection (old up along the new view direction) takes k = 0.
  if (projected.lengthSq() < 1e-24) {
    const horizontal = Math.hypot(d.x, d.z)
    if (horizontal < 1e-9) {
      const elev = d.y >= 0 ? Math.PI / 2 : -Math.PI / 2
      return { azimuth: 0, elevation: elev, roll: 0 }
    }
    const base = anglesFromDirection(d, 0)
    return { azimuth: base.azimuth, elevation: base.elevation, roll: 0 }
  }

  const horizontal = Math.hypot(d.x, d.z)
  const isPole = horizontal < 1e-9

  if (isPole) {
    const elev = d.y >= 0 ? Math.PI / 2 : -Math.PI / 2
    let bestK = 0
    let bestDot = -Infinity
    for (let k = 0; k < 4; k++) {
      const azimuth = (k * Math.PI) / 2
      const candUp = orbitUp(azimuth, elev)
      const dot = candUp.dot(projected)
      if (dot > bestDot) {
        bestDot = dot
        bestK = k
      }
    }
    return { azimuth: (bestK * Math.PI) / 2, elevation: elev, roll: 0 }
  }

  const base = anglesFromDirection(d, 0)

  let bestK = 0
  let bestDot = -Infinity
  for (let k = 0; k < 4; k++) {
    const roll = (k * Math.PI) / 2
    const right = new THREE.Vector3()
    const up = new THREE.Vector3()
    rolledBasis(base.azimuth, base.elevation, roll, right, up)
    const dot = up.dot(projected)
    if (dot > bestDot) {
      bestDot = dot
      bestK = k
    }
  }
  return { azimuth: base.azimuth, elevation: base.elevation, roll: (bestK * Math.PI) / 2 }
}

// The screen up a snap inherits: the old up carried by the shortest rotation
// that takes the old view direction to the new one, which is what a physical
// camera tilt does. Projecting the old up onto the new view plane instead is
// degenerate on the most common gizmo move (a 90 degree tip puts the old up
// along the new view axis), and carrying is never degenerate except on the
// antipodal flip (Front to Back), where any perpendicular axis is a valid
// shortest turn and the old up is the one that keeps the view upright.
export function carriedUp(
  oldUp: THREE.Vector3 | readonly [number, number, number],
  oldDir: THREE.Vector3 | readonly [number, number, number],
  newDir: THREE.Vector3 | readonly [number, number, number],
): THREE.Vector3 {
  const toVec = (v: THREE.Vector3 | readonly [number, number, number]): THREE.Vector3 =>
    v instanceof THREE.Vector3 ? v.clone() : new THREE.Vector3(v[0], v[1], v[2])

  const from = toVec(oldDir)
  const to = toVec(newDir)
  const up = toVec(oldUp)
  if (!(from.lengthSq() > 0) || !(to.lengthSq() > 0)) return up
  from.normalize()
  to.normalize()

  // Only the component across the old view axis is carried: a stale camera.up
  // with a radial part would otherwise land slightly off the new screen plane.
  up.addScaledVector(from, -up.dot(from))
  if (up.lengthSq() < 1e-24) {
    // An up along the view direction cannot name a screen up. World Y is the
    // expected one whenever it is usable; otherwise any perpendicular axis.
    const basis = Math.abs(from.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    up.copy(basis).addScaledVector(from, -basis.dot(from))
  }
  up.normalize()

  if (from.dot(to) < -1 + 1e-9) return up
  return up.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(from, to))
}

// The one programmatic snap used by both the cube click and Normal To: read the
// pose the user is in, carry its screen up to the new view direction, snap that
// to the nearest quarter turn about the direction, then hand the result to the
// controller (or write it onto a controller-less camera). Keeping the block in
// one place is what stops the two snaps drifting apart: the cube click used to
// reset the roll while Normal To kept only a projection of it.
function snapView(
  camera: THREE.Camera,
  controls: Controls,
  direction: THREE.Vector3,
  distance: number,
  target: THREE.Vector3,
): void {
  const oldDir = new THREE.Vector3()
  const oldUp = new THREE.Vector3()
  if (controls) {
    orbitDirection(controls.azimuth, controls.elevation, oldDir)
    rolledBasis(controls.azimuth, controls.elevation, controls.roll, new THREE.Vector3(), oldUp)
  } else {
    // Without a controller the camera is the state: its up is the screen up and
    // its position lies along the orbit direction from the point it faces.
    camera.updateMatrixWorld()
    oldUp.copy(camera.up)
    oldDir.copy(camera.position).sub(target)
    if (oldDir.lengthSq() < 1e-24) oldDir.copy(camera.getWorldDirection(new THREE.Vector3())).negate()
  }

  const pose = nearestSquareRoll(carriedUp(oldUp, oldDir, direction), direction)
  const isPole = Math.hypot(direction.x, direction.z) < 1e-9

  if (controls) {
    controls.setDirection(direction, {
      distance,
      target,
      poleAzimuth: isPole ? pose.azimuth : undefined,
      roll: pose.roll,
    })
    return
  }

  // Rebuild the chosen mark's screen up for the controller-less fallback.
  let chosenUp: THREE.Vector3
  if (isPole) {
    chosenUp = orbitUp(pose.azimuth, pose.elevation)
  } else {
    const right = new THREE.Vector3()
    const up = new THREE.Vector3()
    rolledBasis(pose.azimuth, pose.elevation, pose.roll, right, up)
    chosenUp = up
  }
  camera.up.copy(chosenUp)
  pointCamera(camera, controls, direction, distance, target, isPole ? pose.azimuth : 0)
}

// Look straight at a sketch (or plane) frame from its normal side, centred on
// its origin. This move lands unrolled, so a tilted frame keeps the level
// horizon; only a frame facing straight up or down has a free roll, and there
// the frame's own y axis is put up the screen, so the sketch reads the way it
// was drawn. For the builtin Top plane that is the canonical top view (Front
// at the bottom of the screen).
export function alignToFrame(camera: THREE.Camera, controls: Controls, frame: PlaneTransform): void {
  const r = frame.rotation
  const normal = new THREE.Vector3(r[6], r[7], r[8])
  if (!(normal.lengthSq() > 0)) { traceCamera('alignToFrame', 'degenerate normal'); return }
  traceCamera('alignToFrame', 'origin=', frame.origin)
  const poleAzimuth = poleAzimuthForUp([r[3], r[4], r[5]], normal.y)
  const [ox, oy, oz] = frame.origin
  pointCamera(camera, controls, normal, 100, new THREE.Vector3(ox, oy, oz), poleAzimuth)
}

// Look straight at a face, centred on it.
export function alignToFace(
  camera: THREE.Camera,
  controls: Controls,
  faceNormal: [number, number, number],
  faceCenter: [number, number, number],
): void {
  const [nx, ny, nz] = faceNormal
  const norm = Math.sqrt(nx * nx + ny * ny + nz * nz)
  if (norm === 0) { traceCamera('alignToFace', 'degenerate normal'); return }
  traceCamera('alignToFace', 'center=', faceCenter)

  // Same carried-up snap as a gizmo click: Normal To on a face and a cube click
  // on the parallel face from the same pose must land identically.
  snapView(camera, controls, new THREE.Vector3(nx, ny, nz), 100, new THREE.Vector3(...faceCenter))
}

// Auto-fit is a document-load intent, not a running behaviour: it stays armed
// and retries as geometry populates (bounds and the frustum are not ready on the
// first attempt), then latches once it succeeds. The retry has to be keyed on
// something that changes as geometry arrives, and in the assembly that is the
// `bodies` record -- which a live drag tick also replaces wholesale, every tick
// (assemblyStore.setDragSolveResult merges into a fresh object). A fit still
// armed when the user grabs a part would therefore fire mid-gesture and reframe
// the camera out from under the part being dragged. Once anything has been
// grabbed the framing is the user's; the pending fit is abandoned, not deferred.
export function shouldAutoFit(fitted: boolean, partCount: number, manipulating: boolean): boolean {
  return !fitted && partCount > 0 && !manipulating
}

// Frame all body geometry (or, failing that, all scene meshes) so it fits the
// viewport. Returns false when there is nothing finite to fit yet (geometry not
// arrived), so the caller can retry. Camera-only; never mutates app state.
export function fitToContent(
  camera: THREE.OrthographicCamera,
  controls: Controls,
  parts: Record<string, PartResult> | null | undefined,
  scene: THREE.Scene | null | undefined,
): boolean {
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity

  // Try body vertex data first (fast, accurate).
  if (parts && Object.keys(parts).length > 0) {
    for (const part of Object.values(parts)) {
      const verts = part.mesh?.vertices
      if (!verts) continue
      const bounds = computeVertexBounds(verts)
      if (!bounds) continue
      if (bounds.min[0] < minX) minX = bounds.min[0]; if (bounds.max[0] > maxX) maxX = bounds.max[0]
      if (bounds.min[1] < minY) minY = bounds.min[1]; if (bounds.max[1] > maxY) maxY = bounds.max[1]
      if (bounds.min[2] < minZ) minZ = bounds.min[2]; if (bounds.max[2] > maxZ) maxZ = bounds.max[2]
    }
  }

  // Fall back to scene traversal if no body vertex data found (sketch-only or
  // empty docs). Only meshes tagged userData.fitBounds participate: those are
  // fixed-world-size (plane quads). Screen-scaled helpers (markers, labels,
  // dimension meshes, vertex dots) size themselves as const/zoom, so including
  // them would make the fit a moving target - each press changes zoom, the
  // helpers resize, the next press re-measures different bounds. Measuring only
  // zoom-independent geometry keeps the fit a fixed point (no oscillation).
  if (!Number.isFinite(minX) && scene) {
    const box = new THREE.Box3()
    let hasContent = false
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.userData.fitBounds) {
        obj.geometry.computeBoundingBox()
        const geoBox = obj.geometry.boundingBox
        if (geoBox) {
          box.union(geoBox.clone().applyMatrix4(obj.matrixWorld))
          hasContent = true
        }
      }
    })
    if (hasContent) {
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      if (Number.isFinite(size.x) && Number.isFinite(size.y)) {
        minX = center.x - size.x / 2; maxX = center.x + size.x / 2
        minY = center.y - size.y / 2; maxY = center.y + size.y / 2
        minZ = center.z - size.z / 2; maxZ = center.z + size.z / 2
      }
    }
  }

  if (!Number.isFinite(minX)) { traceCamera('fitToContent', 'no finite bounds yet'); return false }

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const cz = (minZ + maxZ) / 2

  const frustumHeight = camera.top - camera.bottom
  const frustumWidth = camera.right - camera.left
  if (frustumHeight <= 0 || frustumWidth <= 0) { traceCamera('fitToContent', 'frustum not ready'); return false }

  // Project bounding box corners through the view matrix to get screen-space extents.
  camera.updateMatrixWorld()
  const viewMatrix = camera.matrixWorldInverse
  const corners = [
    [minX, minY, minZ], [maxX, minY, minZ], [minX, maxY, minZ], [maxX, maxY, minZ],
    [minX, minY, maxZ], [maxX, minY, maxZ], [minX, maxY, maxZ], [maxX, maxY, maxZ],
  ]
  let minVX = Infinity, maxVX = -Infinity, minVY = Infinity, maxVY = -Infinity
  // View-space z runs negative into the screen; depth is its negation, which is
  // the axis near/far are measured on.
  let minDepth = Infinity, maxDepth = -Infinity
  const tmp = new THREE.Vector3()
  for (const [x, y, z] of corners) {
    tmp.set(x, y, z).applyMatrix4(viewMatrix)
    if (tmp.x < minVX) minVX = tmp.x; if (tmp.x > maxVX) maxVX = tmp.x
    if (tmp.y < minVY) minVY = tmp.y; if (tmp.y > maxVY) maxVY = tmp.y
    if (-tmp.z < minDepth) minDepth = -tmp.z; if (-tmp.z > maxDepth) maxDepth = -tmp.z
  }
  // The world origin counts for depth only: the reference planes and origin
  // marker have to survive the clip even when the model sits far from them, but
  // they must not drag the framing back toward the origin.
  {
    const originDepth = -tmp.set(0, 0, 0).applyMatrix4(viewMatrix).z
    if (originDepth < minDepth) minDepth = originDepth
    if (originDepth > maxDepth) maxDepth = originDepth
  }
  const viewSizeX = maxVX - minVX
  const viewSizeY = maxVY - minVY

  const targetViewHeight = Math.max(viewSizeY * FIT_MARGIN, viewSizeX * FIT_MARGIN * (frustumHeight / frustumWidth))
  const zoom = frustumHeight / targetViewHeight
  if (zoom <= 0 || !Number.isFinite(zoom)) { traceCamera('fitToContent', 'bad zoom', zoom); return false }

  traceCamera('fitToContent', 'center=', [cx, cy, cz], 'zoom=', zoom, 'fromZoom=', readZoom(camera))
  camera.zoom = zoom
  const centerWorld = new THREE.Vector3(cx, cy, cz)
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
  const newPos = camera.position.clone()
    .addScaledVector(camRight, camRight.dot(centerWorld) - camRight.dot(camera.position))
    .addScaledVector(camUp, camUp.dot(centerWorld) - camUp.dot(camera.position))
  camera.position.copy(newPos)

  // Safe after the move: it slid along camRight/camUp, both perpendicular to
  // the view axis, so every depth measured above is unchanged.
  const pad = Math.max((maxDepth - minDepth) * CLIP_PAD_FACTOR, MIN_CLIP_PAD)
  camera.near = minDepth - pad
  camera.far = maxDepth + pad
  traceCamera('fitToContent', 'clip=', [camera.near, camera.far])

  if (controls) {
    // The lateral slide keeps the view direction; only the target moves to the
    // content centre and the distance is re-read from the new standoff. The
    // controller re-applies the same position with its own unclamped roll.
    controls.target.copy(centerWorld)
    controls.distance = Math.max(newPos.distanceTo(centerWorld), 1e-6)
    controls.update()
  } else {
    commitProjection(camera)
  }
  return true
}
