import type * as THREE from 'three'

/**
 * The two matrices that decide where an entity lands in the ID buffer: where
 * the camera sits in the world and how it projects to clip space. OrbitControls
 * dolly on an ORTHOGRAPHIC camera changes only zoom/projectionMatrix and leaves
 * matrixWorld untouched, so a world-matrix-only snapshot misses pure
 * wheel-zooms and lets the ID buffer go stale.
 */
export interface CameraPoseSnapshot {
  matrixWorld: Float32Array
  projectionMatrix: Float32Array
}

const ELEMENTS = 16
// Same per-element tolerance the former world-matrix-only comparison used.
const EPSILON = 1e-6

function differs(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < ELEMENTS; i++) {
    if (Math.abs(a[i] - b[i]) > EPSILON) return true
  }
  return false
}

export function snapshotCameraPose(camera: THREE.Camera): CameraPoseSnapshot {
  return {
    matrixWorld: new Float32Array(camera.matrixWorld.elements),
    projectionMatrix: new Float32Array(camera.projectionMatrix.elements),
  }
}

/**
 * True when either matrix moved since `prev` was captured. A null prev (first
 * frame) counts as unchanged: mounting the driver must not itself dirty the
 * pipeline, mirroring the former first-frame behaviour.
 */
export function cameraPoseChanged(prev: CameraPoseSnapshot | null, camera: THREE.Camera): boolean {
  if (!prev) return false
  return differs(prev.matrixWorld, camera.matrixWorld.elements)
    || differs(prev.projectionMatrix, camera.projectionMatrix.elements)
}
