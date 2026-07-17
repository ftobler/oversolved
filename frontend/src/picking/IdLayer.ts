import * as THREE from 'three'
import type { IdRegistry } from './IdRegistry'

/**
 * Layer-Z policy controls how a layer interacts with the depth buffer
 * relative to layers rendered before it. The pipeline reads this between
 * passes (see IdPipeline.render).
 *
 * - 'depth-test-against-prev': reuse the previous layer's depth values;
 *   used by edges to be culled by faces (future plan #262).
 * - 'clear-then-fresh': clearDepth() then render with normal depth test
 *   and write; used by face layer here, and by helper/plane layers later.
 * - 'no-depth': depth test off, always wins where it draws; used by
 *   gizmo-style layers (vertices in #262, origin in #263).
 */
export type LayerZPolicy = 'depth-test-against-prev' | 'clear-then-fresh' | 'no-depth'

export interface IdLayer {
  readonly name: string
  readonly priority: number
  readonly zPolicy: LayerZPolicy
  /** Scene graph drawn by the pipeline into the ID render target. */
  readonly scene: THREE.Scene
  /** True when the active tool excludes this layer entirely. */
  inertWhen?: () => boolean
  /**
   * Optional pre-render hook. The pipeline calls this with the current
   * render-target dimensions so the layer can update viewport-dependent
   * shader uniforms (screen-space fattening, depth bias).
   */
  onBeforeRender?(width: number, height: number): void
  /** Dispose all GPU resources owned by the layer. */
  dispose(): void
}

/**
 * One registered body's GPU resources, owned by the base. `M` is the concrete
 * object type a layer draws (Mesh for faces, LineSegments for edges, Points
 * for vertices).
 */
export interface IdLayerBodyRecord<M extends THREE.Object3D = THREE.Object3D> {
  mesh: M
  geometry: THREE.BufferGeometry
  allocatedIds: number[]
}

// Module-level so a given (layer, query) collision warns at most once across the
// whole session. Keys are namespaced by `this.name`, so face and edge layers
// never alias even though they now share this set.
const _warnedDuplicates = new Set<string>()

/**
 * Convenience base: owns a registry reference + a private Scene that
 * concrete layers populate. Subclasses implement the actual registration
 * surface (e.g. FaceIdLayer.registerBody).
 */
export abstract class IdLayerBase<M extends THREE.Object3D = THREE.Object3D> implements IdLayer {
  abstract readonly name: string
  abstract readonly priority: number
  abstract readonly zPolicy: LayerZPolicy
  readonly scene: THREE.Scene = new THREE.Scene()

  protected registry: IdRegistry
  protected bodies = new Map<string, IdLayerBodyRecord<M>>()
  constructor(registry: IdRegistry) { this.registry = registry }

  unregisterBody(bodyKey: string): void {
    const rec = this.bodies.get(bodyKey)
    if (!rec) return
    this.scene.remove(rec.mesh)
    rec.geometry.dispose()
    for (const id of rec.allocatedIds) this.registry.free(id)
    this.bodies.delete(bodyKey)
  }

  /** Test helper: number of registered bodies. */
  bodyCount(): number { return this.bodies.size }

  /** Drop every registered body's GPU resources; call from a subclass `dispose`
   *  before disposing the layer's own materials. */
  protected disposeBodies(): void {
    for (const key of [...this.bodies.keys()]) this.unregisterBody(key)
  }

  /**
   * Dev-only diagnostic: warn once when two primitives in the same body resolve
   * to the same query string (their selection IDs would not be unique).
   * `seenInBody` is true once at least one distinct primitive has been allocated
   * in the current body; `noun` is the singular primitive name (e.g. "face").
   */
  protected warnDuplicateQuery(query: string, seenInBody: boolean, bodyKey: string, label: string, noun: string): void {
    if (import.meta.env?.MODE === 'production') return
    const dedupKey = `${this.name}\x00${query}`
    if (this.registry.lookupKey(this.name, query) !== undefined && seenInBody && !_warnedDuplicates.has(dedupKey)) {
      _warnedDuplicates.add(dedupKey)
      console.warn(
        `[${label}] Two ${noun}s share the same query string in ${bodyKey}. ` +
        `query="${query}". Selection IDs will not be unique.`
      )
    }
  }

  abstract dispose(): void
}
