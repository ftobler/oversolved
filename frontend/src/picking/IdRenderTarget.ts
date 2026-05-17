import * as THREE from 'three'

/**
 * Off-screen RGBA8 render target that backs the collision-ID buffer.
 *
 * RGB encodes a 24-bit entity ID (see idEncoding). Alpha is the "occupied"
 * flag: 255 where any layer drew, 0 where the target was cleared.
 */
export class IdRenderTarget {
  readonly target: THREE.WebGLRenderTarget
  private width: number
  private height: number
  private dirty = true

  constructor(width: number, height: number) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.target = new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    })
  }

  getWidth(): number { return this.width }
  getHeight(): number { return this.height }
  isDirty(): boolean { return this.dirty }
  markDirty(): void { this.dirty = true }
  markClean(): void { this.dirty = false }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.target.setSize(w, h)
    this.dirty = true
  }

  dispose(): void {
    this.target.dispose()
  }
}
