import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { BodyResult } from '@/types/cad'
import { INITIAL_ZOOM } from './cameraConstants'

// How much of the viewport the framed content fills: targetViewHeight =
// contentHeight * FIT_MARGIN, so content occupies 1/FIT_MARGIN of the frustum.
// Higher means more breathing room (zoomed out further). This is the single
// knob for "how tight is zoom-to-fit" - it is the only thing that decides
// framing now that fit-to-content is the one camera-framing path (the old
// fixed-pose Reset Viewport is gone).
export const FIT_MARGIN = 2.5

// ─── camera chokepoint ───
// Every programmatic camera move in the viewport goes through this module.
// The camera itself is otherwise only touched by the user (OrbitControls) and
// created once by the <Canvas>. Having a single set of writers means one place
// answers "what moved the camera, and why" - flip CAMERA_TRACE to true to
// follow every move with its trigger source, which is what makes
// hard-to-reproduce viewport bugs traceable instead of a needle in a haystack.
export const CAMERA_TRACE = false

export function traceCamera(op: string, ...detail: unknown[]): void {
  if (CAMERA_TRACE) console.log(`[camera] ${op}`, ...detail)
}

type Controls = OrbitControlsImpl | null

// updateProjectionMatrix lives on the camera subclasses (Ortho/Perspective),
// not the THREE.Camera base type. Our camera is always one of those.
function commitProjection(camera: THREE.Camera): void {
  (camera as THREE.OrthographicCamera).updateProjectionMatrix()
}

function readZoom(camera: THREE.Camera): number {
  return 'zoom' in camera ? (camera as unknown as { zoom: number }).zoom : INITIAL_ZOOM
}

// Rotate to look down the given direction (gizmo face/edge/corner click),
// preserving the current distance from the origin.
export function snapToDirection(camera: THREE.Camera, controls: Controls, dir: THREE.Vector3): void {
  const d = dir.clone().normalize()
  const dist = camera.position.length()
  traceCamera('snapToDirection', 'dir=', d.toArray())
  camera.position.copy(d.multiplyScalar(dist))
  controls?.target.set(0, 0, 0)
  controls?.update()
}

const PLANE_DIRECTIONS: Record<string, [number, number, number]> = {
  builtin_plane_front: [0, 0, 100],
  builtin_plane_top: [0, 100, 0],
  builtin_plane_right: [100, 0, 0],
  builtin_plane_bottom: [0, -100, 0],
  builtin_plane_back: [0, 0, -100],
  builtin_plane_left: [-100, 0, 0],
}

// Look straight at a builtin plane.
export function alignToPlane(camera: THREE.Camera, controls: Controls, planeId: string): void {
  const direction = PLANE_DIRECTIONS[planeId]
  if (!direction) { traceCamera('alignToPlane', 'unknown plane', planeId); return }
  traceCamera('alignToPlane', planeId)

  const distance = 100
  const [dx, dy, dz] = direction
  const norm = Math.sqrt(dx * dx + dy * dy + dz * dz)
  camera.position.set((dx / norm) * distance, (dy / norm) * distance, (dz / norm) * distance)
  camera.lookAt(0, 0, 0)
  controls?.target.set(0, 0, 0)
  controls?.update()
  commitProjection(camera)
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

  const distance = 100
  const ndx = nx / norm, ndy = ny / norm, ndz = nz / norm
  camera.position.set(
    faceCenter[0] + ndx * distance,
    faceCenter[1] + ndy * distance,
    faceCenter[2] + ndz * distance,
  )
  camera.lookAt(faceCenter[0], faceCenter[1], faceCenter[2])
  controls?.target.set(faceCenter[0], faceCenter[1], faceCenter[2])
  controls?.update()
  commitProjection(camera)
}

// Frame all body geometry (or, failing that, all scene meshes) so it fits the
// viewport. Returns false when there is nothing finite to fit yet (geometry not
// arrived), so the caller can retry. Camera-only; never mutates app state.
export function fitToContent(
  camera: THREE.OrthographicCamera,
  controls: Controls,
  bodies: Record<string, BodyResult> | null | undefined,
  scene: THREE.Scene | null | undefined,
): boolean {
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity

  // Try body vertex data first (fast, accurate).
  if (bodies && Object.keys(bodies).length > 0) {
    for (const body of Object.values(bodies)) {
      const verts = body.mesh?.vertices
      if (!verts) continue
      if (verts instanceof Float32Array) {
        for (let i = 0; i < verts.length; i += 3) {
          const x = verts[i], y = verts[i + 1], z = verts[i + 2]
          if (!Number.isFinite(x)) continue
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
        }
      } else {
        for (const [x, y, z] of verts) {
          if (!Number.isFinite(x)) continue
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
        }
      }
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
  const tmp = new THREE.Vector3()
  for (const [x, y, z] of corners) {
    tmp.set(x, y, z).applyMatrix4(viewMatrix)
    if (tmp.x < minVX) minVX = tmp.x; if (tmp.x > maxVX) maxVX = tmp.x
    if (tmp.y < minVY) minVY = tmp.y; if (tmp.y > maxVY) maxVY = tmp.y
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
  controls?.target.set(cx, cy, cz)
  controls?.update()
  commitProjection(camera)
  return true
}
