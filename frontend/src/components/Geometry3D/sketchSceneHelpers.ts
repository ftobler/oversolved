import * as THREE from 'three'

// Three-object helpers for the sketch scene. The pure sampling and bounds math
// stays in utils/geometry/sketchHelpers; only what needs a THREE.Camera or
// THREE.Shape lives here, on the UI side of the boundary.

// World units per pixel for an orthographic camera.
//
// A perspective camera has no distance-free world-per-pixel: world size depends
// on depth. The old helper's `'zoom' in camera ? 1 / zoom : 1` never caught one
// (three's PerspectiveCamera carries a `zoom` too, defaulting to 1), so every
// screen-space size silently became 1 world unit per pixel. Throw instead, so a
// future perspective mode must add its own distance-aware helper rather than
// ship wrong sizes. Inert today: every Canvas here is orthographic, and its
// call site casts to OrthographicCamera.
export function p2w(camera: THREE.Camera): number {
  const ortho = camera as THREE.OrthographicCamera
  if (!ortho.isOrthographicCamera) {
    throw new Error('p2w requires an orthographic camera; a perspective camera has no distance-free world-per-pixel')
  }
  if (!Number.isFinite(ortho.zoom) || ortho.zoom === 0) {
    throw new Error('p2w requires a finite, non-zero camera zoom')
  }
  return 1 / ortho.zoom
}

// Pre-built unit arrow shape: tip at origin, pointing +X, base at x=-1
export const ARROW_SHAPE = (() => {
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.lineTo(-1, 0.4)
  s.lineTo(-1, -0.4)
  s.closePath()
  return s
})()
