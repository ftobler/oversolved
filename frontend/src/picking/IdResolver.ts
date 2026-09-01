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
  // Pixel distance from the cursor center.
  distancePx: number
}

/**
 * Where the cursor really is inside the window, and how far a pick reaches.
 *
 * Both exist because a pixel is an area and a cursor is a point. The ID mark
 * for a vertex is the pixel its projection lands in, whose CENTRE is up to half
 * a pixel off the vertex itself; the cursor likewise sits somewhere inside its
 * own pixel. Measuring index-to-index throws both fractions away and they do
 * not cancel -- the leftover lands entirely on one side, so the reach runs up
 * to 2 px further toward -x/-y (left and up on screen) than the other way.
 *
 * Giving the resolver the sub-pixel offset lets it measure from where the
 * cursor actually is to where each pixel's centre actually is. What remains is
 * the mark's own half-pixel quantisation, which is unavoidable at one pixel per
 * vertex and is at least unbiased.
 */
export interface WindowGeometry {
  // Cursor position relative to the centre pixel's CENTRE, in pixels.
  cursorOffsetX?: number
  cursorOffsetY?: number
  // Pick reach from the cursor. Defaults to the window's half-width.
  radiusPx?: number
}

export interface ResolveOptions {
  // Square window edge in pixels; the pick reach is the disc inscribed in it,
  // so 17 means a true 8 px snap radius in every direction.
  windowSize?: number
  // Optional filter: only return hits in these layers.
  allowedLayers?: ReadonlySet<string>
  /**
   * Layer name → priority mapping. When present the resolver picks the
   * highest-priority layer first, then the nearest pixel within that layer.
   * Without it the resolver picks the nearest pixel regardless of layer
   * (legacy behaviour).
   */
  layerPriority?: Readonly<Record<string, number>>
  /**
   * Sub-pixel cursor placement and reach. Supplied by `IdPipeline.readWindow`,
   * which is the only caller that knows where inside its pixel the cursor sat.
   * Omitted, distances fall back to whole-pixel offsets from the centre pixel.
   */
  windowGeometry?: WindowGeometry
}

/**
 * Decode an N x N RGBA pixel window into EVERY distinct entity it covers, each
 * carrying its nearest pixel's distance, ordered by layer priority (highest
 * first) then by distance (nearest first).
 *
 * "Covers" means the disc inscribed in the window, not the whole square: a
 * pixel further than the window's half-width from the centre is discarded, so
 * the reach is the same in every direction. See the cutoff in the scan below.
 *
 * This is the pick contract the assembly's mate authoring needs (Stage 7): a
 * single pixel at a corner covers three faces, three edges and a vertex, and a
 * mate ref may legitimately be any of them. The singleton resolvers below are
 * defined as this list's first element, so a hover, a click and a candidate set
 * can never disagree about what "the" hit is.
 *
 * Marks the registry knows to be CO-LOCATED expand into the same list, one
 * candidate each. That is not a second idea beside it: "one pixel, several
 * entities" is what this function has always meant at a corner, and two points
 * at one position are the same situation reached from inside a layer rather
 * than across three. The difference is that a point mark cannot share its
 * pixel, so without the expansion the losers are not ranked last, they are
 * absent -- see `IdRegistry.setMarkPosition`. Everything that already consumes
 * this list covers them with no change.
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
  geometry?: WindowGeometry,
): ResolvedHit[] {
  if (windowSize <= 0) return []
  if (pixels.length < windowSize * windowSize * 4) {
    throw new Error(`resolvePixelWindow: buffer too small for ${windowSize}x${windowSize}`)
  }

  const center = (windowSize - 1) / 2
  // The cursor's true position in window-pixel coordinates, and the reach from
  // it. Both default to the centre pixel's index, which is the whole-pixel
  // behaviour every caller that passes no geometry still gets.
  const cursorX = center + (geometry?.cursorOffsetX ?? 0)
  const cursorY = center + (geometry?.cursorOffsetY ?? 0)
  const radius = geometry?.radiusPx ?? center

  // Nearest pixel per distinct entity id. `scanIndex` is where that nearest
  // pixel sat in the row-major scan: it breaks a distance tie toward whichever
  // entity reached the tied distance first, which is the rule the single-hit
  // resolver has always used. Without it a tie would fall to first-*seen* order,
  // and an entity whose first pixel was far but whose nearest pixel is tied
  // would jump ahead of one that was near all along.
  interface Candidate { hit: ResolvedHit; prio: number; scanIndex: number; markOrder: number }
  const bestPerId = new Map<number, Candidate>()
  const prioOf = (layer: string): number => layerPriority?.[layer] ?? 0

  let scanIndex = 0
  for (let y = 0; y < windowSize; y++) {
    for (let x = 0; x < windowSize; x++, scanIndex++) {
      const i = (y * windowSize + x) * 4
      const a = pixels[i + 3]
      if (a === 0) continue

      const dx = x - cursorX
      const dy = y - cursorY
      const dist = Math.hypot(dx, dy)
      // The window is read as a square because that is the only shape a pixel
      // blit has, but the reach it stands for is a radius. Without this the
      // square IS the catch region, so a pick carries 8 px straight out and
      // 11.3 px into the corners -- the same point answers from half again as
      // far when approached diagonally. Discarding the corners costs nothing
      // else: distance already orders candidates, it just never rejected one.
      if (dist > radius) continue

      const id = rgbToId(pixels[i], pixels[i + 1], pixels[i + 2])
      if (id === EMPTY_ID) continue
      const rec: IdRecord | undefined = registry.lookup(id)
      if (!rec) continue
      if (allowedLayers && !allowedLayers.has(rec.layer)) continue

      const existing = bestPerId.get(id)
      if (!existing) {
        bestPerId.set(id, {
          hit: { id, layer: rec.layer, entityKey: rec.entityKey, pickKey: rec.pickKey, distancePx: dist },
          prio: prioOf(rec.layer),
          scanIndex,
          markOrder: 0,
        })
      } else if (dist < existing.hit.distancePx) {
        existing.hit.distancePx = dist
        existing.scanIndex = scanIndex
      }
    }
  }

  // Expand each lit mark into everything registered at its position, then sort
  // the whole set once. Sorting after the expansion rather than before is what
  // keeps the result a straight priority-then-distance ordering of ENTITIES: a
  // recovered mark carries its own layer, so it has to be ranked on its own
  // priority and not inherited into the position of the mark that outdrew it.
  const candidates: Candidate[] = []
  const seen = new Set<number>()
  for (const c of bestPerId.values()) {
    const coincident = registry.coincidentMarkIds(c.hit.id)
    if (coincident.length < 2) {
      if (!seen.has(c.hit.id)) { seen.add(c.hit.id); candidates.push(c) }
      continue
    }
    for (let m = 0; m < coincident.length; m++) {
      const mid = coincident[m]
      if (seen.has(mid)) continue
      if (mid === c.hit.id) {
        seen.add(mid)
        candidates.push({ ...c, markOrder: m })
        continue
      }
      const rec = registry.lookup(mid)
      if (!rec) continue
      if (allowedLayers && !allowedLayers.has(rec.layer)) continue
      seen.add(mid)
      candidates.push({
        // The recovered mark owns no pixel, so it borrows the distance of the
        // one that covered it -- which is exact, not an approximation: they are
        // at the same position, so the cursor is the same distance from both.
        hit: {
          id: mid, layer: rec.layer, entityKey: rec.entityKey, pickKey: rec.pickKey,
          distancePx: c.hit.distancePx,
        },
        prio: prioOf(rec.layer),
        scanIndex: c.scanIndex,
        markOrder: m,
      })
    }
  }

  return candidates
    .sort((p, q) => (q.prio - p.prio) || (p.hit.distancePx - q.hit.distancePx)
      || (p.scanIndex - q.scanIndex) || (p.markOrder - q.markOrder))
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
  geometry?: WindowGeometry,
): ResolvedHit | null {
  return resolvePixelWindowAll(pixels, windowSize, registry, allowedLayers, layerPriority, geometry)[0] ?? null
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

  // Allocate (or reuse) the scratch buffer for a given window size.
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
    return resolvePixelWindow(scratch, windowSize, this.registry, opts?.allowedLayers, opts?.layerPriority, opts?.windowGeometry)
  }

  // Every entity the window covers, priority-then-distance ordered.
  decodeAll(scratch: Uint8Array, windowSize: number, opts?: ResolveOptions): ResolvedHit[] {
    return resolvePixelWindowAll(scratch, windowSize, this.registry, opts?.allowedLayers, opts?.layerPriority, opts?.windowGeometry)
  }

  getScratchBuffer(windowSize: number): Uint8Array {
    return this.ensureScratch(windowSize)
  }
}
