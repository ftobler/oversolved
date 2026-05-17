import * as THREE from 'three'
import { IdRegistry } from './IdRegistry'
import { IdRenderTarget } from './IdRenderTarget'
import { IdResolver, type ResolveOptions, type ResolvedHit } from './IdResolver'
import { FaceIdLayer } from './FaceIdLayer'
import type { IdLayer } from './IdLayer'

export const DEFAULT_WINDOW_SIZE = 17

export interface IdPipelineOptions {
  width: number
  height: number
  /** Pixel window size for hover/click resolves. Default 17. */
  windowSize?: number
}

/**
 * Orchestrates the off-screen ID render target, its layers, and the
 * resolver. One instance per Canvas.
 *
 * Slice scope (id-buffer-core.md): face layer only. Dirty flag is wired
 * but invalidation sources (camera/scene/resize) land in id-buffer-perf.md.
 * For now, callers can `markDirty()` directly and the pipeline will render
 * once on the next `renderIfDirty()`.
 */
export class IdPipeline {
  readonly registry: IdRegistry
  readonly target: IdRenderTarget
  readonly resolver: IdResolver
  readonly faceLayer: FaceIdLayer
  private layers: IdLayer[]
  private windowSize: number

  constructor(opts: IdPipelineOptions) {
    this.registry = new IdRegistry()
    this.target = new IdRenderTarget(opts.width, opts.height)
    this.resolver = new IdResolver(this.registry)
    this.faceLayer = new FaceIdLayer(this.registry)
    this.layers = []
    this.addLayer(this.faceLayer)
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE
  }

  /**
   * Mount a layer. Layers are rendered in ascending `priority` order
   * (lowest priority first, highest priority drawn last and therefore
   * highest pick precedence within the depth-test policy).
   * Used by future plans (#262 edges/vertices, #263 sketches) to extend
   * the pipeline without modifying this class.
   */
  addLayer(layer: IdLayer): void {
    this.layers.push(layer)
    this.layers.sort((a, b) => a.priority - b.priority)
  }

  /** Test helper: snapshot of mounted layers in render order. */
  getLayers(): readonly IdLayer[] {
    return this.layers
  }

  markDirty(): void {
    this.target.markDirty()
  }

  resize(width: number, height: number): void {
    this.target.resize(width, height)
  }

  /**
   * Render every active layer into the ID target with its declared
   * z-policy. Caller passes the active camera so the offscreen view
   * matches the visible scene.
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    const prevTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear
    const prevClearColor = new THREE.Color()
    renderer.getClearColor(prevClearColor)
    const prevClearAlpha = renderer.getClearAlpha()

    renderer.setRenderTarget(this.target.target)
    renderer.autoClear = false
    renderer.setClearColor(0x000000, 0)  // alpha=0 -> empty
    renderer.clear(true, true, false)

    for (const layer of this.layers) {
      if (layer.inertWhen?.()) continue
      if (layer.scene.children.length === 0) continue

      switch (layer.zPolicy) {
        case 'clear-then-fresh':
          renderer.clearDepth()
          break
        case 'no-depth':
          renderer.clearDepth()
          break
        case 'depth-test-against-prev':
          break
      }
      renderer.render(layer.scene, camera)
    }

    renderer.setRenderTarget(prevTarget)
    renderer.autoClear = prevAutoClear
    renderer.setClearColor(prevClearColor, prevClearAlpha)

    this.target.markClean()
    this.registry.bumpCycle()
  }

  renderIfDirty(renderer: THREE.WebGLRenderer, camera: THREE.Camera): boolean {
    if (!this.target.isDirty()) return false
    this.render(renderer, camera)
    return true
  }

  /**
   * Synchronously resolve the entity under the cursor by reading a window
   * from the ID target. Cursor coordinates are canvas pixels with origin
   * at the top-left; this method translates to the renderer's bottom-left
   * read origin internally.
   *
   * Returns null when the window is empty or the cursor is off-screen.
   */
  resolveSync(
    renderer: THREE.WebGLRenderer,
    cursorPx: { x: number; y: number },
    opts?: ResolveOptions,
  ): ResolvedHit | null {
    const w = this.target.getWidth()
    const h = this.target.getHeight()
    const windowSize = opts?.windowSize ?? this.windowSize

    const cx = Math.round(cursorPx.x)
    const cy = Math.round(cursorPx.y)
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null

    // Convert canvas cursor (top-left origin) to render-target read origin
    // (bottom-left): readY = h - cy - 1. The window of size N is centered
    // on (cx, readY), so its bottom-left corner is at (cx - half, readY - half).
    const half = Math.floor(windowSize / 2)
    const readY = h - cy - 1
    const x0 = cx - half
    const y0 = readY - half
    const readW = windowSize
    const readH = windowSize
    if (x0 + readW <= 0 || y0 + readH <= 0 || x0 >= w || y0 >= h) return null

    const scratch = this.resolver.getScratchBuffer(windowSize)
    // Bound-clip the read; pixels outside the target are left zero (empty),
    // which the resolver treats as "no entity".
    scratch.fill(0)
    const clampX = Math.max(0, x0)
    const clampY = Math.max(0, y0)
    const clampW = Math.min(w - clampX, readW - (clampX - x0))
    const clampH = Math.min(h - clampY, readH - (clampY - y0))
    if (clampW <= 0 || clampH <= 0) return null

    const sub = new Uint8Array(clampW * clampH * 4)
    renderer.readRenderTargetPixels(this.target.target, clampX, clampY, clampW, clampH, sub)

    // Stitch sub into scratch at the right offset. Row 0 of sub corresponds
    // to readY clamped from below (small y); resolver expects row 0 = top
    // (small canvas y = large readY), so flip vertically while stitching.
    const offsetX = clampX - x0
    const offsetY = clampY - y0
    for (let row = 0; row < clampH; row++) {
      const srcRow = row
      // Flip: scratch row 0 is the top of the canvas window; sub row 0 is
      // bottom of the read region; so scratch row = (readH - 1) - (offsetY + row).
      const dstRow = (readH - 1) - (offsetY + srcRow)
      if (dstRow < 0 || dstRow >= readH) continue
      const srcBase = srcRow * clampW * 4
      const dstBase = (dstRow * readW + offsetX) * 4
      scratch.set(sub.subarray(srcBase, srcBase + clampW * 4), dstBase)
    }

    return this.resolver.decode(scratch, windowSize, opts)
  }

  dispose(): void {
    this.faceLayer.dispose()
    this.target.dispose()
    this.registry.clear()
  }
}
