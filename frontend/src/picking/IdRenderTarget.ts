import * as THREE from 'three'

/**
 * Off-screen RGBA8 render target that backs the collision-ID buffer.
 *
 * RGB encodes a 24-bit entity ID (see idEncoding). Alpha is the "occupied"
 * flag: 255 where any layer drew, 0 where the target was cleared.
 *
 * A section view needs a stencil buffer for its cap occluder (the same
 * stencil-count pass the visible scene runs), so the target can be re-created
 * with one and back without one. The attachment set is fixed at allocation
 * time in WebGL, so `setStencil` swaps the target rather than flipping a flag;
 * the old one is disposed in the same call, which is the one lifecycle the
 * caller has to know about.
 */
export class IdRenderTarget {
  private _target: THREE.WebGLRenderTarget
  private width: number
  private height: number
  private dirty = true
  private stencil: boolean

  constructor(width: number, height: number, stencil = false) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.stencil = stencil
    this._target = this.createTarget()
  }

  get target(): THREE.WebGLRenderTarget { return this._target }
  getWidth(): number { return this.width }
  getHeight(): number { return this.height }
  isDirty(): boolean { return this.dirty }
  hasStencil(): boolean { return this.stencil }
  markDirty(): void { this.dirty = true }
  markClean(): void { this.dirty = false }

  /**
   * Add or drop the stencil attachment. The size survives the swap and the
   * buffer is marked dirty so the next pick re-renders against the new target
   * instead of reading an empty or stale one.
   */
  setStencil(enabled: boolean): void {
    if (this.stencil === enabled) return
    this.stencil = enabled
    const previous = this._target
    this._target = this.createTarget()
    previous.dispose()
    this.dirty = true
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this._target.setSize(w, h)
    this.dirty = true
  }

  dispose(): void {
    this._target.dispose()
  }

  private createTarget(): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: this.stencil,
    })
  }
}
