import * as THREE from 'three'
import { isDevBuild } from '@/kernel/isDevBuild'
import { IdRegistry } from './IdRegistry'
import { IdRenderTarget } from './IdRenderTarget'
import { IdResolver, type ResolveOptions, type ResolvedHit, type WindowGeometry } from './IdResolver'
import { FaceIdLayer } from './FaceIdLayer'
import { EdgeIdLayer } from './EdgeIdLayer'
import { VertexIdLayer } from './VertexIdLayer'
import type { IdLayer } from './IdLayer'
import {
  PLANE_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME,
  SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
  FEATURE_HANDLE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME,
} from './layerNames'

// Layer name constants now live in the pure ./layerNames module (no three.js)
// so tool/selection policy can import them headlessly. Re-export here so the
// @/picking barrel and existing import sites keep resolving them unchanged.
export {
  PLANE_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME,
  SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
  FEATURE_HANDLE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME,
}

/**
 * Edge of the square pick window, in CSS pixels; the reach it stands for is the
 * radius of the disc inscribed in it, 8 px around the cursor.
 *
 * CSS and not device pixels, because the two diverge on every HiDPI display and
 * only one of them is the affordance. The ID target is allocated at
 * drawing-buffer resolution (`IdPickingDriver`'s `getDrawingBufferSize`) and the
 * cursor is converted into those same device pixels, so a window taken
 * literally as device pixels shrinks to 8/DPR CSS pixels. That matters most for
 * the helper vertex layers -- sketch vertices, the origin marker, dimension
 * labels -- which each mark a single point (`VertexIdLayer`'s points path), so
 * the window is not a tolerance around their footprint, it IS their whole catch
 * radius. At DPR 2 that radius lands at 4 CSS px, inside the 5 px radius of the
 * dot a sketch point draws, so the user aims at a dot whose own rim is out of
 * range. A sketch entity nearby keeps answering not because it is drawn fat --
 * `EdgeIdLayer` rasterises 1 px lines too -- but because a curve marks a
 * contiguous RUN of pixels, so it is far likelier than an isolated dot to have
 * one of them inside a shrunken window. `getEffectiveWindowSize` scales this
 * back into device pixels at read time.
 */
export const DEFAULT_WINDOW_SIZE = 17

/**
 * Bounds on the device-pixel ratio the pick window is scaled by.
 *
 * The floor is the load-bearing one. Below 100% browser zoom the ratio drops
 * under 1 (the rubber band already contends with that, see useRubberBandSelect),
 * and honouring it literally would read FEWER device pixels than the flat 17
 * this window was before it scaled at all -- turning a fix for HiDPI into a
 * regression for anyone zoomed out. Holding at 1 makes the scale strictly
 * one-way: never tighter than it has always been, more generous as the display
 * gets denser.
 *
 * The ceiling catches a nonsense ratio (a mis-sized canvas reporting a huge
 * drawing buffer) before it turns one hover into a 66 KB readback. No real
 * display is near it.
 */
const MIN_PICK_PIXEL_RATIO = 1
const MAX_PICK_PIXEL_RATIO = 8

/**
 * Consecutive per-layer render failures tolerated before the layer is latched
 * out of the pipeline. One transient throw keeps today's behaviour (buffer
 * stays dirty, retry next frame); a layer that fails this many frames in a row
 * is broken, and holding the whole buffer dirty for it disables every pick.
 * Latching it out trades that layer's picks for the rest of the scene's.
 */
const LAYER_FAILURE_LATCH_THRESHOLD = 2

/**
 * A CSS-pixel window edge converted to a device-pixel one.
 *
 * The DPR scale is applied to the window's RADIUS, not its edge, because the
 * radius is the quantity with a meaning -- how far from the cursor a pick
 * reaches. The odd edge is then rebuilt from it, which keeps the centre pixel
 * the cursor's own (the resolver measures distance from `(n - 1) / 2`) instead
 * of letting the shared centre pixel get scaled along with the two sides.
 */
function scaledWindowSize(cssSize: number, ratio: number): number {
  // Guarded like the ratio is: a non-finite size would survive every downstream
  // check (`NaN <= 0` and `length < NaN` are both false), so the resolver would
  // answer an empty window instead of failing.
  const css = Number.isFinite(cssSize) ? Math.max(1, Math.round(cssSize)) : DEFAULT_WINDOW_SIZE
  const cssRadius = (css - 1) / 2
  return 2 * Math.round(cssRadius * ratio) + 1
}

// Screen-space edge length of the B-rep vertex pick cube. Three pixels is the
// smallest odd size that still leaves a lit centre pixel after rasterisation,
// and its half-extent toward the camera is what lifts the vertex out of the
// face it sits on in the depth buffer.
export const VERTEX_PICK_CUBE_PIXELS = 3

// The largest device-pixel window `readWindow` can ever ask for: the default CSS
// window scaled by the DPR ceiling, plus the one-pixel margin it reads on every
// side. The clipped sub-region read is bounded by this, so one buffer this size
// is reused for every hover instead of a fresh Uint8Array per sub-read.
const MAX_READ_WINDOW_DEVICE_SIZE = scaledWindowSize(DEFAULT_WINDOW_SIZE, MAX_PICK_PIXEL_RATIO) + 2
// Deliberately the exact worst-case common-path sub-read size, so the grow check
// in readWindow never fires for the default window. If a scaledWindowSize
// rounding change ever makes the common path exceed this, size up to keep that
// path allocation-free -- it must never reallocate at read time.
const MAX_READ_WINDOW_BYTES = MAX_READ_WINDOW_DEVICE_SIZE * MAX_READ_WINDOW_DEVICE_SIZE * 4

export interface IdPipelineOptions {
  width: number
  height: number
  // Pick window edge in CSS pixels for hover/click resolves. Default 17.
  windowSize?: number
  /**
   * Device pixels per CSS pixel of the ID target. Default 1; the driver keeps
   * it in step with the canvas each frame via `setPixelRatio`.
   */
  pixelRatio?: number
}

interface PendingAsyncQuery {
  cursorPx: { x: number; y: number }
  opts: ResolveOptions | undefined
  // Every caller waiting for the result of this (or any superseding) read.
  subscribers: ((hit: ResolvedHit | null) => void)[]
}

/**
 * Orchestrates the off-screen ID render target, its layers, and the
 * resolver. One instance per Canvas.
 *
 * Mounts the full ladder of pick layers (plane, B-rep face/edge/vertex, sketch
 * surface/entity/vertex, origin, dimension label, feature handle, gizmo handle),
 * ordered by priority. The driver auto-marks the buffer dirty on a camera-pose
 * change and on resize; callers can also `markDirty()` directly. The next
 * `renderIfDirty()` renders once, and `render()` marks the buffer clean unless a
 * layer failed.
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
  readonly featureHandleLayer: EdgeIdLayer
  readonly gizmoHandleLayer: FaceIdLayer
  private layers: IdLayer[]
  // CSS pixels; see DEFAULT_WINDOW_SIZE.
  private windowSize: number
  private pixelRatio = 1
  private renderCount = 0
  private lastDirtyReason: string | null = null
  private nextAsync: PendingAsyncQuery | null = null
  private inFlightAsync: PendingAsyncQuery | null = null
  private disposed = false
  // Consecutive render-failure count per layer name; reset to 0 on any success.
  private layerFailureStreak = new Map<string, number>()
  // Layers that hit the failure threshold and are now skipped entirely. The
  // buffer is allowed to go clean without them.
  private latchedOutLayers = new Set<string>()
  // Cached layer name to priority map. Rebuilt lazily and only invalidated by
  // addLayer; resolveSync/resolveAllSync read it on every hover, so a fresh
  // Record per call was pure churn.
  private layerPriorityCache: Readonly<Record<string, number>> | null = null
  // Reusable scratch for readWindow's clipped sub-region read, pre-sized to the
  // largest window the DPR cap allows. Grows only if a caller ever configures a
  // window larger than the default. Held here and not beside the resolver's
  // decode scratch because only readWindow stitches through it.
  private subScratch = new Uint8Array(MAX_READ_WINDOW_BYTES)

  // Reused across render()'s renderer-state save/restore so a hover frame mints
  // no THREE objects, mirroring the pose-buffer reuse in IdPickingDriver.
  private readonly prevClearColorScratch = new THREE.Color()
  private readonly prevViewportScratch = new THREE.Vector4()
  private readonly prevScissorScratch = new THREE.Vector4()

  constructor(opts: IdPipelineOptions) {
    this.registry = new IdRegistry()
    this.target = new IdRenderTarget(opts.width, opts.height)
    this.resolver = new IdResolver(this.registry)
    // B-rep layers (face/edge/vertex) at priorities 0/10/20.
    this.faceLayer = new FaceIdLayer(this.registry)
    this.edgeLayer = new EdgeIdLayer(this.registry)
    // depth-test-against-prev keeps B-rep face depth alive for the sketch surface
    // layer. The vertex cubes have real depth extent, so ordinary depth testing
    // ranks vertex over edge over face without any always-win escape hatch.
    this.vertexLayer = new VertexIdLayer(this.registry, {
      zPolicy: 'depth-test-against-prev', cubePixels: VERTEX_PICK_CUBE_PIXELS,
    })

    // Helper layers. The plane renders at a negative priority so it sits
    // behind the B-rep stack -- bodies occlude the plane in the ID buffer.
    // Order: planeFace (-10) -> B-rep (0/10/20) -> sketchSurface (30) ->
    // sketchEntity (40) -> originMarker (45) -> sketchVertex (50) -> ...
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
    // Below the sketch vertex rather than above it, which is the one place the
    // ladder is not simply "later layers win". The origin has to beat the plane,
    // the body and the sketch geometry it sits on -- that is what 45 buys, and
    // it is why the marker is up here at all. It must NOT beat a sketch point
    // that shares its position, which happens the moment anything is
    // constrained to it, i.e. in almost every sketch: the marker is a global
    // datum that can be neither dragged nor dimensioned, so answering with it
    // where a real point exists takes capability away, while constraining to a
    // point already pinned to the origin lands in the same place. The point is
    // the more specific of two things at one spot, which is the rule the rest
    // of the ladder already expresses.
    this.originLayer = new VertexIdLayer(this.registry, {
      name: ORIGIN_LAYER_NAME, priority: 45, zPolicy: 'no-depth',
    })
    this.dimensionLabelLayer = new VertexIdLayer(this.registry, {
      name: DIMENSION_LABEL_LAYER_NAME, priority: 70, zPolicy: 'no-depth',
    })
    // Feature editing handles (draggable extrude/fillet/revolve arrows) sit on
    // top of everything: while a handle is shown the user is mid-edit and the
    // grab gesture must never lose to a body or label underneath. An edge
    // layer, not a vertex layer: the whole arrow line is the grab target, so
    // the pick region matches the visible arrow instead of one snap point.
    this.featureHandleLayer = new EdgeIdLayer(this.registry, {
      name: FEATURE_HANDLE_LAYER_NAME, priority: 80, zPolicy: 'no-depth',
      depthTest: false, depthWrite: false,
    })
    // The assembly triad, one step above even the feature handles: while a
    // triad is shown the part under it is already selected, so a pixel the
    // gizmo covers can only mean "grab the gizmo". A face layer, not an edge
    // one: the rings and plane quads are areas, not lines. `no-depth` clears
    // the depth buffer first, so the handles win against the body they sit
    // inside while still occluding each other correctly.
    this.gizmoHandleLayer = new FaceIdLayer(this.registry, {
      name: GIZMO_HANDLE_LAYER_NAME, priority: 90, zPolicy: 'no-depth',
    })

    this.layers = []
    this.addLayer(this.planeLayer)           // -10  behind everything
    this.addLayer(this.faceLayer)            //   0
    this.addLayer(this.edgeLayer)            //  10
    this.addLayer(this.vertexLayer)  //  20
    this.addLayer(this.sketchSurfaceLayer)  //  30
    this.addLayer(this.sketchEntityLayer)    //  40
    this.addLayer(this.originLayer)          //  45
    this.addLayer(this.sketchVertexLayer)    //  50
    this.addLayer(this.dimensionLabelLayer)  //  70
    this.addLayer(this.featureHandleLayer)   //  80
    this.addLayer(this.gizmoHandleLayer)     //  90

    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE
    this.setPixelRatio(opts.pixelRatio ?? 1)
  }

  /**
   * Mount a layer. Layers are rendered in ascending `priority` order
   * (lowest priority first, highest priority drawn last and therefore
   * highest pick precedence within the depth-test policy).
   * Lets the pipeline grow its layer set without modifying this class.
   */
  addLayer(layer: IdLayer): void {
    this.layers.push(layer)
    this.layers.sort((a, b) => a.priority - b.priority)
    // The priority map is derived from this.layers. Also invalidate here if a
    // removeLayer is ever added.
    this.layerPriorityCache = null
  }

  // Snapshot of mounted layers in render order.
  getLayers(): readonly IdLayer[] {
    return this.layers
  }

  // Layer name → priority mapping for the resolver.
  getLayerPriority(): Readonly<Record<string, number>> {
    if (this.layerPriorityCache) return this.layerPriorityCache
    const map: Record<string, number> = {}
    for (const l of this.layers) map[l.name] = l.priority
    this.layerPriorityCache = map
    return map
  }

  /**
   * Device pixels per CSS pixel of the ID target. The driver recomputes it each
   * frame from the drawing-buffer / canvas size ratio, so a window move to
   * another display (or a browser zoom) is picked up without a remount.
   *
   * Lives on the pipeline rather than being read off the renderer so the whole
   * resolve path stays testable without a GL context.
   */
  setPixelRatio(ratio: number): void {
    this.pixelRatio = Number.isFinite(ratio) && ratio > 0
      ? Math.min(Math.max(ratio, MIN_PICK_PIXEL_RATIO), MAX_PICK_PIXEL_RATIO)
      : 1
  }

  getPixelRatio(): number {
    return this.pixelRatio
  }

  // The configured window edge in CSS pixels (what the user aims with).
  getWindowSize(): number {
    return this.windowSize
  }

  /**
   * The window actually read from the target, in device pixels: the CSS-pixel
   * window's radius scaled by the current pixel ratio, with the odd edge rebuilt
   * from it. This is what keeps the catch radius a constant on-screen distance
   * at every DPR.
   */
  getEffectiveWindowSize(cssWindowSize?: number): number {
    return scaledWindowSize(cssWindowSize ?? this.windowSize, this.pixelRatio)
  }

  markDirty(reason?: string): void {
    this.target.markDirty()
    if (reason) this.lastDirtyReason = reason
  }

  // Test/debug accessor for the most recent reason passed to markDirty().
  getLastDirtyReason(): string | null {
    return this.lastDirtyReason
  }

  // Test accessor: total number of times render() has executed.
  getRenderCount(): number {
    return this.renderCount
  }

  isDirty(): boolean {
    return this.target.isDirty()
  }

  // Canary accessor for the publish invariant: a disposed pipeline must never
  // reach the live slot, because its async resolve path is permanently deaf.
  isDisposed(): boolean {
    return this.disposed
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
    const prevClearColor = this.prevClearColorScratch
    renderer.getClearColor(prevClearColor)
    const prevClearAlpha = renderer.getClearAlpha()
    const prevViewport = this.prevViewportScratch
    const prevScissor = this.prevScissorScratch
    const hasViewportApi = typeof renderer.getViewport === 'function' && typeof renderer.setViewport === 'function'
    const hasScissorApi = typeof renderer.getScissor === 'function'
      && typeof renderer.setScissor === 'function'
      && typeof renderer.getScissorTest === 'function'
      && typeof renderer.setScissorTest === 'function'
    if (hasViewportApi) renderer.getViewport(prevViewport)
    if (hasScissorApi) renderer.getScissor(prevScissor)
    const prevScissorTest = hasScissorApi ? renderer.getScissorTest() : false
    let completed = false
    // Names of layers whose pass threw this cycle, consulted after the state
    // restore to decide whether the buffer may be marked clean.
    const failedLayers: string[] = []
    try {
      renderer.setRenderTarget(this.target.target)
      renderer.autoClear = false
      renderer.setClearColor(0x000000, 0)  // alpha=0 -> empty
      renderer.clear(true, true, false)

      const w = this.target.getWidth()
      const h = this.target.getHeight()
      let firstLayer = true

      for (const layer of this.layers) {
        if (layer.scene.children.length === 0) continue
        // A latched-out layer is a known-broken pass. Skipping it before the
        // depth-clear switch keeps a later clear-then-fresh layer from
        // inheriting its stale decision, exactly as a throw would.
        if (this.latchedOutLayers.has(layer.name)) continue
        try {
          layer.onBeforeRender?.(w, h, this.pixelRatio)

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
          // Advance before the render call, not after: a throw inside render()
          // must still leave the depth-clear decision correct for the layers
          // that follow.
          firstLayer = false
          renderer.render(layer.scene, camera)
          this.layerFailureStreak.set(layer.name, 0)
        } catch (err) {
          // Skip only the failing layer; keep the pipeline alive.
          failedLayers.push(layer.name)
          const streak = (this.layerFailureStreak.get(layer.name) ?? 0) + 1
          this.layerFailureStreak.set(layer.name, streak)
          // Dev-gated: this repeats per failing frame, so the ungated latch warn
          // below is the production signal that the layer's picking is gone.
          if (isDevBuild()) console.warn(`ID layer render failed: ${layer.name}`, err)
          if (streak >= LAYER_FAILURE_LATCH_THRESHOLD) {
            // One warn at the latch transition, not one per frame. Reported in
            // every build: the pipeline has no useNotify, so this line is the
            // only channel a lost layer's picking gets.
            this.latchedOutLayers.add(layer.name)
            console.warn(
              `ID layer latched out after ${streak} consecutive render failures; `
              + `picking on it is disabled until reload: ${layer.name}`,
              err,
            )
          }
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
      // A freshly failed layer leaves the buffer amputated: marking it clean
      // would make every later resolve answer from a partial image. Stay dirty
      // so the next frame retries; the caller's rAF loop already paces that at
      // one attempt per frame. A layer that has been latched out is a
      // deliberate amputation the pipeline has already accepted and warned
      // about, so it must not keep the buffer dirty forever.
      const blocking = failedLayers.filter(name => !this.latchedOutLayers.has(name))
      if (blocking.length === 0) this.target.markClean()
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
    const read = this.readWindow(renderer, cursorPx, opts)
    if (!read) return null
    return this.resolver.decode(read.scratch, read.windowSize,
      { ...opts, layerPriority: this.getLayerPriority(), windowGeometry: read.geometry })
  }

  /**
   * Every entity under the cursor, not just the winner. The mate pick chip
   * consumes this: at a corner one pixel names several matable entities, and the
   * user cycles among them. `resolveAllSync(...)[0]` is `resolveSync(...)`.
   */
  resolveAllSync(
    renderer: THREE.WebGLRenderer,
    cursorPx: { x: number; y: number },
    opts?: ResolveOptions,
  ): ResolvedHit[] {
    const read = this.readWindow(renderer, cursorPx, opts)
    if (!read) return []
    return this.resolver.decodeAll(read.scratch, read.windowSize,
      { ...opts, layerPriority: this.getLayerPriority(), windowGeometry: read.geometry })
  }

  // Blit the pixel window under the cursor into the resolver's scratch buffer.
  private readWindow(
    renderer: THREE.WebGLRenderer,
    cursorPx: { x: number; y: number },
    opts?: ResolveOptions,
  ): { scratch: Uint8Array; windowSize: number; geometry: WindowGeometry } | null {
    if (this.target.isDirty()) return null  // render target is stale
    const w = this.target.getWidth()
    const h = this.target.getHeight()
    // opts.windowSize, like the pipeline default, is CSS pixels; the read below
    // is in device pixels, so it goes through the same DPR scale.
    const reachSize = this.getEffectiveWindowSize(opts?.windowSize)
    const radius = (reachSize - 1) / 2
    // Read one pixel wider on every side than the reach. The cursor sits
    // anywhere inside its own pixel, so the disc of radius `radius` around it
    // extends up to a pixel past the window that would be centred on that pixel
    // alone; without the margin the disc would be clipped on whichever side the
    // cursor leans toward, which is the asymmetry this whole path is here to
    // avoid. The resolver still cuts at `radius`, so the extra ring only ever
    // supplies pixels, never reach.
    const windowSize = reachSize + 2

    // floor, not round: the window is centred on the pixel the cursor is INSIDE.
    // Rounding centres it on the nearest pixel BOUNDARY instead, which offsets
    // the window half a pixel from the cursor on average.
    const cx = Math.floor(cursorPx.x)
    const cy = Math.floor(cursorPx.y)
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null

    // Where the cursor sits relative to that pixel's centre, which is what lets
    // the resolver measure a true distance instead of an index difference.
    const geometry: WindowGeometry = {
      cursorOffsetX: cursorPx.x - (cx + 0.5),
      cursorOffsetY: cursorPx.y - (cy + 0.5),
      radiusPx: radius,
    }

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

    // Reuse the pre-sized scratch; grow it only if a caller ever configures a
    // window past the DPR-capped default. The buffer must be zeroed first, like
    // the fresh Uint8Array it replaced: readRenderTargetPixels has early-return
    // paths (no framebuffer yet, context loss) that leave it untouched, and a
    // stale tail from the previous hover would then stitch into the resolver
    // scratch and decode a phantom entity instead of resolving null.
    const subBytes = clampW * clampH * 4
    if (this.subScratch.length < subBytes) this.subScratch = new Uint8Array(subBytes)
    this.subScratch.fill(0, 0, subBytes)
    const sub = this.subScratch.subarray(0, subBytes)
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
      const srcBase = srcRow * clampW * 4
      const dstBase = (dstRow * readW + offsetX) * 4
      scratch.set(sub.subarray(srcBase, srcBase + clampW * 4), dstBase)
    }

    return { scratch, windowSize, geometry }
  }

  /**
   * Asynchronously resolve the entity under the cursor. Latest-wins
   * coalescing: if a new query arrives while one is in flight, the older
   * promise resolves with the newer cursor's result, so callers can safely
   * fire one query per pointermove without queueing up reads.
   *
   * The read itself is the synchronous path, deferred by a microtask; the async
   * wrapper only coalesces callers and settles them together.
   */
  resolveAsync(
    renderer: THREE.WebGLRenderer,
    cursorPx: { x: number; y: number },
    opts?: ResolveOptions,
  ): Promise<ResolvedHit | null> {
    // Post-dispose contract: a read over the dead target can only answer
    // "nothing", so answer it directly instead of scheduling work.
    if (this.disposed) return Promise.resolve(null)
    return new Promise<ResolvedHit | null>((resolve) => {
      // If a read is currently in flight, the caller will receive whatever
      // the NEXT scheduled read returns, i.e. the latest cursor wins.
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
      // dispose() already settled every subscriber with null and nulled the
      // queues; re-entering done() here would double-settle and resurrect a
      // queue on a dead pipeline.
      if (this.disposed) return
      let hit: ResolvedHit | null = null
      try {
        hit = this.resolveSync(renderer, query.cursorPx, query.opts)
      } catch (err) {
        // A throwing readback used to strand every later hover: done() never
        // ran, inFlightAsync stayed set, and each pointermove leaked a
        // never-settled promise. Settle with null and let done() drain the
        // queue; the throw is caught here so it cannot surface as an unhandled
        // rejection. Dev-gated because a persistently broken readback would
        // otherwise warn once per pointer move; the loss is one dropped hover.
        if (isDevBuild()) console.warn('ID async resolve read failed', err)
      }
      done(hit)
    })
  }

  dispose(): void {
    // Settle every pending async-resolve subscriber with null, mirroring how a
    // failed readback resolves null: leaving the promises pending would hang
    // their callers and pin the closures forever. The deferred read microtask
    // sees empty queues and bows out.
    for (const query of [this.inFlightAsync, this.nextAsync]) {
      if (!query) continue
      for (const settle of query.subscribers) settle(null)
    }
    this.inFlightAsync = null
    this.nextAsync = null
    this.disposed = true
    // Mark the target dirty before tearing it down: readWindow bails on a dirty
    // target before any GL call, so a resolveSync or a late async microtask that
    // races dispose answers null instead of calling readRenderTargetPixels on a
    // disposed WebGLRenderTarget (which silently re-creates its GPU buffers).
    this.target.markDirty()
    for (const layer of this.layers) layer.dispose()
    this.target.dispose()
    this.registry.clear()
  }
}
