import * as THREE from 'three'

/**
 * Index-keyed BufferGeometry cache that builds an entry the first time it is
 * asked for one.
 *
 * The highlight overlays it backs (a hovered face outline, a selected edge) are
 * drawn a handful at a time, but a body carries one candidate per face and per
 * edge. Building them all when the body mounts put that entire cost between the
 * finished solve and the first painted frame, which is exactly where a heavy
 * model cannot afford it. `null` entries are cached too, so a primitive with no
 * segments is not rebuilt on every render.
 *
 * `dispose()` releases every geometry handed out so far; call it from the same
 * effect cleanup the eager Map version used.
 */
export interface LazyGeometryCache {
  get(index: number): THREE.BufferGeometry | null
  dispose(): void
  /** Test/diagnostic: how many entries have actually been built. */
  size(): number
}

export function lazyGeometryCache(
  buildSegments: (index: number) => Float32Array | null,
): LazyGeometryCache {
  const cache = new Map<number, THREE.BufferGeometry | null>()
  return {
    get(index: number): THREE.BufferGeometry | null {
      const hit = cache.get(index)
      if (hit !== undefined) return hit
      const points = buildSegments(index)
      let geometry: THREE.BufferGeometry | null = null
      if (points && points.length > 0) {
        geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(points, 3))
      }
      cache.set(index, geometry)
      return geometry
    },
    dispose(): void {
      for (const geometry of cache.values()) geometry?.dispose()
      cache.clear()
    },
    size(): number {
      return cache.size
    },
  }
}
