import { EMPTY_ID, rgbToId } from './idEncoding'
import type { IdRegistry, IdRecord } from './IdRegistry'

export interface ResolvedHit {
  id: number
  layer: string
  entityKey: string
  /** Per-primitive allocation identity (unique in the ID buffer). Used to
   *  isolate the single hovered primitive; equals `entityKey` for layers that
   *  pass no explicit pick key. Optional so hand-built hits (tests) can omit it;
   *  the real resolver always populates it. */
  pickKey?: string
  /** Pixel distance from the cursor center. */
  distancePx: number
}

export interface ResolveOptions {
  /** Square window edge in pixels. Default 17 (8 px snap radius). */
  windowSize?: number
  /** Optional filter: only return hits in these layers. */
  allowedLayers?: ReadonlySet<string>
  /**
   * Layer name → priority mapping. When present the resolver picks the
   * highest-priority layer first, then the nearest pixel within that layer.
   * Without it the resolver picks the nearest pixel regardless of layer
   * (legacy behaviour).
   */
  layerPriority?: Readonly<Record<string, number>>
}

/**
 * Decode an N x N RGBA pixel window into EVERY distinct entity it covers, each
 * carrying its nearest pixel's distance, ordered by layer priority (highest
 * first) then by distance (nearest first).
 *
 * This is the pick contract the assembly's mate authoring needs (Stage 7): a
 * single pixel at a corner covers three faces, three edges and a vertex, and a
 * mate ref may legitimately be any of them. The singleton resolvers below are
 * defined as this list's first element, so a hover, a click and a candidate set
 * can never disagree about what "the" hit is.
 *
 * `pixels` is laid out row-major, row 0 = top row of the window in canvas
 * coordinates (the caller is responsible for matching `readRenderTargetPixels`'s
 * y-flipped origin; this resolver is geometry-agnostic).
 */
export function resolvePixelWindowAll(
  pixels: Uint8Array,
  windowSize: number,
  registry: IdRegistry,
  allowedLayers?: ReadonlySet<string>,
  layerPriority?: Readonly<Record<string, number>>,
): ResolvedHit[] {
  if (windowSize <= 0) return []
  if (pixels.length < windowSize * windowSize * 4) {
    throw new Error(`resolvePixelWindow: buffer too small for ${windowSize}x${windowSize}`)
  }

  const center = (windowSize - 1) / 2

  // Nearest pixel per distinct entity id. `scanIndex` is where that nearest
  // pixel sat in the row-major scan: it breaks a distance tie toward whichever
  // entity reached the tied distance first, which is the rule the single-hit
  // resolver has always used. Without it a tie would fall to first-*seen* order,
  // and an entity whose first pixel was far but whose nearest pixel is tied
  // would jump ahead of one that was near all along.
  interface Candidate { hit: ResolvedHit; prio: number; scanIndex: number }
  const bestPerId = new Map<number, Candidate>()

  let scanIndex = 0
  for (let y = 0; y < windowSize; y++) {
    for (let x = 0; x < windowSize; x++, scanIndex++) {
      const i = (y * windowSize + x) * 4
      const a = pixels[i + 3]
      if (a === 0) continue
      const id = rgbToId(pixels[i], pixels[i + 1], pixels[i + 2])
      if (id === EMPTY_ID) continue
      const rec: IdRecord | undefined = registry.lookup(id)
      if (!rec) continue
      if (allowedLayers && !allowedLayers.has(rec.layer)) continue

      const dx = x - center
      const dy = y - center
      const dist = Math.hypot(dx, dy)

      const existing = bestPerId.get(id)
      if (!existing) {
        bestPerId.set(id, {
          hit: { id, layer: rec.layer, entityKey: rec.entityKey, pickKey: rec.pickKey, distancePx: dist },
          prio: layerPriority?.[rec.layer] ?? 0,
          scanIndex,
        })
      } else if (dist < existing.hit.distancePx) {
        existing.hit.distancePx = dist
        existing.scanIndex = scanIndex
      }
    }
  }

  return [...bestPerId.values()]
    .sort((p, q) => (q.prio - p.prio) || (p.hit.distancePx - q.hit.distancePx) || (p.scanIndex - q.scanIndex))
    .map(c => c.hit)
}

/**
 * Decode an N x N RGBA pixel window into a single hit: the nearest non-empty
 * pixel within the highest-priority layer present.
 */
export function resolvePixelWindow(
  pixels: Uint8Array,
  windowSize: number,
  registry: IdRegistry,
  allowedLayers?: ReadonlySet<string>,
  layerPriority?: Readonly<Record<string, number>>,
): ResolvedHit | null {
  return resolvePixelWindowAll(pixels, windowSize, registry, allowedLayers, layerPriority)[0] ?? null
}

/**
 * Cursor-driven resolver. Holds a Uint8Array scratch buffer and a reference
 * to the registry; consumers call `resolve(cursorPx, registry)` after the
 * pipeline has rendered the ID target.
 */
export class IdResolver {
  private scratch: Uint8Array | null = null
  private scratchSize = 0

  private registry: IdRegistry
  constructor(registry: IdRegistry) { this.registry = registry }

  /** Allocate (or reuse) the scratch buffer for a given window size. */
  private ensureScratch(windowSize: number): Uint8Array {
    if (!this.scratch || this.scratchSize !== windowSize) {
      this.scratchSize = windowSize
      this.scratch = new Uint8Array(windowSize * windowSize * 4)
    }
    return this.scratch
  }

  /**
   * Read a square window centered on the canvas-space cursor and resolve
   * the nearest non-empty entity. Returns null if the window is empty.
   *
   * The caller is responsible for calling `readRenderTargetPixels` with the
   * provided scratch buffer (we pass it back so the GL read uses the same
   * buffer the resolver decodes).
   */
  decode(scratch: Uint8Array, windowSize: number, opts?: ResolveOptions): ResolvedHit | null {
    return resolvePixelWindow(scratch, windowSize, this.registry, opts?.allowedLayers, opts?.layerPriority)
  }

  /** Every entity the window covers, priority-then-distance ordered. */
  decodeAll(scratch: Uint8Array, windowSize: number, opts?: ResolveOptions): ResolvedHit[] {
    return resolvePixelWindowAll(scratch, windowSize, this.registry, opts?.allowedLayers, opts?.layerPriority)
  }

  getScratchBuffer(windowSize: number): Uint8Array {
    return this.ensureScratch(windowSize)
  }
}
