import * as THREE from 'three'
import { IdRegistry } from './IdRegistry'
import { IdRenderTarget } from './IdRenderTarget'
import { IdResolver, type ResolveOptions, type ResolvedHit } from './IdResolver'
import { FaceIdLayer } from './FaceIdLayer'
import { EdgeIdLayer } from './EdgeIdLayer'
import { VertexIdLayer } from './VertexIdLayer'
import type { IdLayer } from './IdLayer'
import {
  PLANE_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME,
  SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
  FEATURE_HANDLE_LAYER_NAME,
} from './layerNames'

// Layer name constants now live in the pure ./layerNames module (no three.js)
// so tool/selection policy can import them headlessly. Re-export here so the
// @/picking barrel and existing import sites keep resolving them unchanged.
export {
  PLANE_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME,
  SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
  FEATURE_HANDLE_LAYER_NAME,
}
export const SKETCH_ENTITY_FAT_PIXELS = 8
export const SKETCH_VERTEX_FAT_PIXELS = 12
export const ORIGIN_FAT_PIXELS = 14
// Matches the visible-pass hit radius after Linear.tsx's per-frame
// `30 * p2w(camera)` scale on the unit circleGeometry hit mesh.
export const DIMENSION_LABEL_FAT_PIXELS = 18

export const DEFAULT_WINDOW_SIZE = 17

export interface IdPipelineOptions {
  width: number
  height: number
  /** Pixel window size for hover/click resolves. Default 17. */
  windowSize?: number
  /**
   * When true, the pipeline re-renders the ID buffer every frame while
   * the camera is in motion. Default false (matches "suppress hover during
   * camera motion" stance in the architecture).
   */
  pickDuringCameraMotion?: boolean
}

interface PendingAsyncQuery {
  cursorPx: { x: number; y: number }
  opts: ResolveOptions | undefined
  /** Every caller waiting for the result of this (or any superseding) read. */
  subscribers: ((hit: ResolvedHit | null) => void)[]
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
  readonly edgeLayer: EdgeIdLayer
  readonly vertexLayer: VertexIdLayer
  readonly planeLayer: FaceIdLayer
  readonly sketchEntityLayer: EdgeIdLayer
  readonly sketchSurfaceLayer: FaceIdLayer
  readonly sketchVertexLayer: VertexIdLayer
  readonly originLayer: VertexIdLayer
  readonly dimensionLabelLayer: VertexIdLayer
  readonly featureHandleLayer: VertexIdLayer
  private layers: IdLayer[]
  private windowSize: number
  private renderCount = 0
  private lastDirtyReason: string | null = null
  pickDuringCameraMotion: boolean
  private nextAsync: PendingAsyncQuery | null = null
  private inFlightAsync: PendingAsyncQuery | null = null

  constructor(opts: IdPipelineOptions) {
    this.registry = new IdRegistry()
    this.target = new IdRenderTarget(opts.width, opts.height)
    this.resolver = new IdResolver(this.registry)
    // B-rep layers (face/edge/vertex) at priorities 0/10/20.
    this.faceLayer = new FaceIdLayer(this.registry)
    this.edgeLayer = new EdgeIdLayer(this.registry)
    // depth-test-against-prev keeps B-rep face depth alive for the sketch surface
    // layer; the material still has depthTest=false so B-rep vertices always win.
    this.vertexLayer = new VertexIdLayer(this.registry, { zPolicy: 'depth-test-against-prev' })

    // Helper layers. The plane renders at a negative priority so it sits
    // behind the B-rep stack -- bodies occlude the plane in the ID buffer.
    // Order: planeFace (-10) -> B-rep (0/10/20) -> sketchEntity (40) -> ...
    this.planeLayer = new FaceIdLayer(this.registry, {
      name: PLANE_LAYER_NAME, priority: -10, zPolicy: 'clear-then-fresh',
    })
    this.sketchSurfaceLayer = new FaceIdLayer(this.registry, {
      name: SKETCH_SURFACE_LAYER_NAME, priority: 30, zPolicy: 'depth-test-against-prev',
    })
    this.sketchEntityLayer = new EdgeIdLayer(this.registry, {
      name: SKETCH_ENTITY_LAYER_NAME, priority: 40, zPolicy: 'clear-then-fresh',
      depthTest: false, depthWrite: false,
    })
    this.sketchVertexLayer = new VertexIdLayer(this.registry, {
      name: SKETCH_VERTEX_LAYER_NAME, priority: 50, zPolicy: 'no-depth',
    })
    this.originLayer = new VertexIdLayer(this.registry, {
      name: ORIGIN_LAYER_NAME, priority: 60, zPolicy: 'no-depth',
    })
    this.dimensionLabelLayer = new VertexIdLayer(this.registry, {
      name: DIMENSION_LABEL_LAYER_NAME, priority: 70, zPolicy: 'no-depth',
    })
    // Feature editing handles (draggable extrude/fillet/revolve arrows) sit on
    // top of everything: while a handle is shown the user is mid-edit and the
    // grab gesture must never lose to a body or label underneath.
    this.featureHandleLayer = new VertexIdLayer(this.registry, {
      name: FEATURE_HANDLE_LAYER_NAME, priority: 80, zPolicy: 'no-depth',
    })

    this.layers = []
    this.addLayer(this.planeLayer)           // -10  behind everything
    this.addLayer(this.faceLayer)            //   0
    this.addLayer(this.edgeLayer)            //  10
    this.addLayer(this.vertexLayer)            //  20
    this.addLayer(this.sketchSurfaceLayer)    //  30
    this.addLayer(this.sketchEntityLayer)    //  40
    this.addLayer(this.sketchVertexLayer)    //  50
    this.addLayer(this.originLayer)          //  60
    this.addLayer(this.dimensionLabelLayer)  //  70
    this.addLayer(this.featureHandleLayer)   //  80

    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE
    this.pickDuringCameraMotion = opts.pickDuringCameraMotion ?? false
  }

  /**
   * Mark the three B-rep layers (face/edge/vertex) inert based on a
   * caller-supplied predicate. Used to silence B-rep picking while a
   * sketch is being edited (matches Body3D's `interactive={!activeFeatureId}`
   * visible-pass rule from #221). When `predicate` returns true the
   * layers are simply not rendered into the ID buffer, so the resolver
   * cannot return a B-rep entity.
   */
  setBrepInertPredicate(predicate: (() => boolean) | null): void {
    const inertWhen = predicate ?? undefined
    this.faceLayer.inertWhen = inertWhen
    this.edgeLayer.inertWhen = inertWhen
    this.vertexLayer.inertWhen = inertWhen
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

  /** Snapshot of mounted layers in render order. */
  getLayers(): readonly IdLayer[] {
    return this.layers
  }

  /** Layer name → priority mapping for the resolver. */
  getLayerPriority(): Readonly<Record<string, number>> {
    const map: Record<string, number> = {}
    for (const l of this.layers) map[l.name] = l.priority
    return map
  }

  markDirty(reason?: string): void {
    this.target.markDirty()
    if (reason) this.lastDirtyReason = reason
  }

  /** Test/debug accessor for the most recent reason passed to markDirty(). */
  getLastDirtyReason(): string | null {
    return this.lastDirtyReason
  }

  /** Test accessor: total number of times render() has executed. */
  getRenderCount(): number {
    return this.renderCount
  }

  isDirty(): boolean {
    return this.target.isDirty()
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
    const prevViewport = new THREE.Vector4()
    const prevScissor = new THREE.Vector4()
    const hasViewportApi = typeof renderer.getViewport === 'function' && typeof renderer.setViewport === 'function'
    const hasScissorApi = typeof renderer.getScissor === 'function'
      && typeof renderer.setScissor === 'function'
      && typeof renderer.getScissorTest === 'function'
      && typeof renderer.setScissorTest === 'function'
    if (hasViewportApi) renderer.getViewport(prevViewport)
    if (hasScissorApi) renderer.getScissor(prevScissor)
    const prevScissorTest = hasScissorApi ? renderer.getScissorTest() : false
    let completed = false
    try {
      renderer.setRenderTarget(this.target.target)
      renderer.autoClear = false
      renderer.setClearColor(0x000000, 0)  // alpha=0 -> empty
      renderer.clear(true, true, false)

      const w = this.target.getWidth()
      const h = this.target.getHeight()
      let firstLayer = true

      for (const layer of this.layers) {
        if (layer.inertWhen?.()) continue
        if (layer.scene.children.length === 0) continue
        try {
          layer.onBeforeRender?.(w, h)

          switch (layer.zPolicy) {
            case 'clear-then-fresh':
              // Buffer-level clear at the top of render() already provides a
              // fresh depth attachment for the first layer; clear again only
              // when a later layer requests a fresh depth window.
              if (!firstLayer) renderer.clearDepth()
              break
            case 'no-depth':
              // Vertex-style layers run with depthTest disabled at the material
              // level, but we still clear depth so any future variant that does
              // want depth gets a fresh slate.
              renderer.clearDepth()
              break
            case 'depth-test-against-prev':
              // Reuse the previous layer's depth -- this is how edges get
              // culled by faces. No clear.
              break
          }
          renderer.render(layer.scene, camera)
          firstLayer = false
        } catch (err) {
          // Skip only the failing layer; keep the pipeline alive.
          console.warn(`ID layer render failed: ${layer.name}`, err)
        }
      }

      completed = true
    } finally {
      renderer.setRenderTarget(prevTarget)
      renderer.autoClear = prevAutoClear
      renderer.setClearColor(prevClearColor, prevClearAlpha)
      if (hasViewportApi) renderer.setViewport(prevViewport)
      if (hasScissorApi) {
        renderer.setScissor(prevScissor)
        renderer.setScissorTest(prevScissorTest)
      }
    }

    if (completed) {
      this.target.markClean()
      this.registry.bumpCycle()
      this.renderCount++
    }
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
   *
   * When the pipeline is dirty (pending re-render after geometry change),
   * the render target has stale pixel data. Resolving against stale data
   * can return wrong entityKeys (freed IDs recycled for different entities)
   * or null (freed IDs removed from the registry). This guard returns null
   * to skip stale resolves, at the cost of one frame of missed picks during
   * scene transitions. The caller's `onPointerMissed` handler should be
   * aware that a null return can be a transient transition state, not
   * necessarily empty space.
   */
  resolveSync(
    renderer: THREE.WebGLRenderer,
    cursorPx: { x: number; y: number },
    opts?: ResolveOptions,
  ): ResolvedHit | null {
    if (this.target.isDirty()) return null  // render target is stale
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

    return this.resolver.decode(scratch, windowSize, { ...opts, layerPriority: this.getLayerPriority() })
  }

  /**
   * Asynchronously resolve the entity under the cursor. Latest-wins
   * coalescing: if a new query arrives while one is in flight, the older
   * promise resolves with the newer cursor's result, so callers can safely
   * fire one query per pointermove without queueing up reads.
   *
   * Uses `readRenderTargetPixelsAsync` when available (three.js r150+);
   * falls back to the synchronous read otherwise. The fallback still
   * preserves the latest-wins semantics so call sites can be uniform.
   */
  resolveAsync(
    renderer: THREE.WebGLRenderer,
    cursorPx: { x: number; y: number },
    opts?: ResolveOptions,
  ): Promise<ResolvedHit | null> {
    return new Promise<ResolvedHit | null>((resolve) => {
      // If a read is currently in flight, the caller will receive whatever
      // the NEXT scheduled read returns — i.e. the latest cursor wins.
      // Multiple synchronous calls before any microtask runs all coalesce
      // into a single queued read at the latest cursor.
      if (this.inFlightAsync) {
        if (this.nextAsync) {
          this.nextAsync.cursorPx = cursorPx
          this.nextAsync.opts = opts
          this.nextAsync.subscribers.push(resolve)
        } else {
          this.nextAsync = { cursorPx, opts, subscribers: [resolve] }
        }
        return
      }
      if (this.nextAsync) {
        // Coalesce with the not-yet-started query.
        this.nextAsync.cursorPx = cursorPx
        this.nextAsync.opts = opts
        this.nextAsync.subscribers.push(resolve)
        return
      }
      const query: PendingAsyncQuery = { cursorPx, opts, subscribers: [resolve] }
      this.inFlightAsync = query
      // Defer the actual read to a microtask so any further synchronous
      // resolveAsync calls in this turn get folded into nextAsync and
      // supersede this read.
      Promise.resolve().then(() => {
        const head = this.inFlightAsync
        if (!head) return
        // If a newer cursor arrived synchronously, promote it before reading.
        if (this.nextAsync) {
          for (const s of head.subscribers) this.nextAsync.subscribers.push(s)
          this.inFlightAsync = this.nextAsync
          this.nextAsync = null
        }
        this.runAsync(renderer, this.inFlightAsync!)
      })
    })
  }

  private runAsync(renderer: THREE.WebGLRenderer, query: PendingAsyncQuery): void {
    const done = (hit: ResolvedHit | null) => {
      for (const s of query.subscribers) s(hit)
      if (this.nextAsync) {
        const next = this.nextAsync
        this.nextAsync = null
        this.inFlightAsync = next
        this.runAsync(renderer, next)
      } else {
        this.inFlightAsync = null
      }
    }

    // Reliability over throughput: use sync read path even for hover coalescing.
    // Some browser/driver combos report:
    //   "INVALID_OPERATION: readPixels: PIXEL_PACK buffer should not be bound"
    // when async and sync reads interleave. resolveSync avoids that path.
    Promise.resolve().then(() => {
      const hit = this.resolveSync(renderer, query.cursorPx, query.opts)
      done(hit)
    })
  }

  dispose(): void {
    for (const layer of this.layers) layer.dispose()
    this.target.dispose()
    this.registry.clear()
  }
}
