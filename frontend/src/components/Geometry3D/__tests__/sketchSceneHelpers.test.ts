import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { p2w } from '@/components/Geometry3D/sketchSceneHelpers'

describe('p2w', () => {
  it('returns the world units per pixel for an orthographic camera', () => {
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    ortho.zoom = 4
    expect(p2w(ortho)).toBeCloseTo(0.25)
  })

  // A perspective camera has no distance-free world-per-pixel. The old helper
  // silently returned 1; the throw is what keeps a future perspective mode from
  // shipping screen-space sizes that are wrong by the whole zoom factor.
  it('throws for a perspective camera instead of silently returning 1', () => {
    const persp = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    expect(() => p2w(persp)).toThrow(/orthographic/i)
  })

  it('throws for a non-finite zoom rather than dividing by it', () => {
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    ortho.zoom = Number.NaN
    expect(() => p2w(ortho)).toThrow(/zoom/i)
  })

  it('inverts the zoom for an orthographic camera', () => {
    const cam = new THREE.OrthographicCamera()
    cam.zoom = 2
    expect(p2w(cam)).toBeCloseTo(0.5)
  })

  it('throws for a camera without an orthographic flag instead of returning 1', () => {
    expect(() => p2w({} as unknown as THREE.Camera)).toThrow(/orthographic/i)
  })
})
