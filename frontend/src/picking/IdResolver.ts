import { EMPTY_ID, rgbToId } from './idEncoding'
import type { IdRegistry, IdRecord } from './IdRegistry'

export interface ResolvedHit {
  id: number
  layer: string
  entityKey: string
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
 * Decode an N x N RGBA pixel window into a single hit by nearest non-empty
 * pixel to the window center.
 *
 * `pixels` is laid out row-major, row 0 = top row of the window in canvas
 * coordinates (the caller is responsible for matching `readRenderTargetPixels`'s
 * y-flipped origin; this resolver is geometry-agnostic).
 */
export function resolvePixelWindow(
  pixels: Uint8Array,
  windowSize: number,
  registry: IdRegistry,
  allowedLayers?: ReadonlySet<string>,
  layerPriority?: Readonly<Record<string, number>>,
): ResolvedHit | null {
  if (windowSize <= 0) return null
  if (pixels.length < windowSize * windowSize * 4) {
    throw new Error(`resolvePixelWindow: buffer too small for ${windowSize}x${windowSize}`)
  }

  const center = (windowSize - 1) / 2

  // Per-priority-level best hit (closest to cursor within that level).
  const bestPerPrio = new Map<number, ResolvedHit>()
  let highestPrio = -Infinity

  for (let y = 0; y < windowSize; y++) {
    for (let x = 0; x < windowSize; x++) {
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
      const prio = layerPriority?.[rec.layer] ?? 0
      if (prio > highestPrio) highestPrio = prio

      const existing = bestPerPrio.get(prio)
      if (!existing || dist < existing.distancePx) {
        bestPerPrio.set(prio, { id, layer: rec.layer, entityKey: rec.entityKey, distancePx: dist })
      }
    }
  }

  if (highestPrio === -Infinity) return null
  return bestPerPrio.get(highestPrio) ?? null
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

  getScratchBuffer(windowSize: number): Uint8Array {
    return this.ensureScratch(windowSize)
  }
}
