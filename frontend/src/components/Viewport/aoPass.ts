import * as THREE from 'three'

// Targets and fullscreen quads for the AO pre-pass + GTAO + denoise. Kept in its
// own module so the presenter stays small and the targets are unit-testable
// against a stand-in renderer.
export class AoPass {
  prepassTarget: THREE.WebGLRenderTarget
  aoTarget: THREE.WebGLRenderTarget
  quadScene: THREE.Scene
  quad: THREE.Mesh
  camera: THREE.OrthographicCamera
  private width = 0
  private height = 0

  constructor() {
    this.prepassTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      stencilBuffer: false,
    })
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1)
    this.quadScene = new THREE.Scene()
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    )
    this.quad.frustumCulled = false
    this.quadScene.add(this.quad)
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 2))
    const h = Math.max(1, Math.floor(height / 2))
    if (this.width === w && this.height === h) return
    this.width = w
    this.height = h
    this.prepassTarget.setSize(w, h)
    this.aoTarget.setSize(w, h)
  }

  dispose(): void {
    this.prepassTarget.dispose()
    this.aoTarget.dispose()
    this.quad.geometry.dispose()
    ;(this.quad.material as THREE.Material).dispose()
  }
}

export class AOPass extends AoPass {}
export class AmbientOcclusionPass extends AoPass {}
export function createAoPass(): AoPass { return new AoPass() }
export const aoPassFactory = createAoPass
