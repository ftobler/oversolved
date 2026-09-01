import * as THREE from 'three'
import type { IdRegistry } from './IdRegistry'
import { idToRGBNormalized } from './idEncoding'
import { primitivePickKey } from './pickKey'

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
 *   gizmo-style layers (sketch vertices, origin marker, dimension labels).
 *   B-rep vertices deliberately do NOT use this: their pick cubes have real
 *   depth extent and rank themselves through the depth buffer.
 */
export type LayerZPolicy = 'depth-test-against-prev' | 'clear-then-fresh' | 'no-depth'

export interface IdLayer {
  readonly name: string
  readonly priority: number
  readonly zPolicy: LayerZPolicy
  // Scene graph drawn by the pipeline into the ID render target.
  readonly scene: THREE.Scene
  // True when the active tool excludes this layer entirely.
  inertWhen?: () => boolean
  /**
   * Optional pre-render hook. The pipeline calls this with the current
   * render-target dimensions so the layer can update viewport-dependent
   * shader uniforms (screen-space fattening, depth bias).
   */
  onBeforeRender?(width: number, height: number): void
  // Dispose all GPU resources owned by the layer.
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
// whole session. Keys are namespaced by the layer name, so face and edge layers
// never alias even though they share this set.
const _warnedDuplicates = new Set<string>()

/**
 * ID allocation for one `registerBody` pass, shared by all three b-rep layers.
 *
 * The layers build very different geometry (Mesh / LineSegments / cube soup) but
 * a primitive earns its ID identically in all three, so that half lives here:
 * which key the ID is allocated under, the dev-only collision diagnostic, the
 * `allocatedIds` list `unregisterBody` gives back, and the primitive -> color
 * memo that lets the many triangles or segments of one primitive share its ID
 * instead of re-allocating per vertex.
 *
 * One instance covers one body and is discarded when registration ends.
 */
export class PrimitiveIdAllocator {
  private readonly registry: IdRegistry
  private readonly layerName: string
  // Plural primitive name for the diagnostic, e.g. "faces".
  private readonly plural: string
  private readonly bodyKey: string
  // See the `perPrimitivePickKeys` doc on each layer's registration type.
  private readonly perPrimitive: boolean | undefined

  private ids = new Set<number>()
  private rgbByIndex = new Map<number, [number, number, number]>()
  private idByIndex = new Map<number, number>()

  constructor(registry: IdRegistry, layerName: string, plural: string, bodyKey: string, perPrimitive: boolean | undefined) {
    this.registry = registry
    this.layerName = layerName
    this.plural = plural
    this.bodyKey = bodyKey
    this.perPrimitive = perPrimitive
  }

  /**
   * IDs taken in this pass, in allocation order, each listed ONCE. A Set and not
   * a push list so the body record is an honest account of the DISTINCT IDs this
   * body holds: in query-keyed mode two primitives sharing a query really do
   * collapse onto one ID (what `warnDuplicateQuery` reports), and listing it
   * twice would make `unregisterBody` free one ID twice for one body.
   *
   * The registry tolerates that double free on its own (`pendingFree` is a Set),
   * and has to: the same collapse happens ACROSS bodies, where nothing at this
   * level can see it. This is the layer keeping its own books straight, not the
   * fix for that bug -- see the `pendingFree` comment in `IdRegistry`.
   *
   * Belongs in the body record: it is the sole account of what `unregisterBody`
   * has to hand back to the registry.
   */
  get allocatedIds(): number[] { return [...this.ids] }

  /**
   * Normalized RGB carrying primitive `idx`'s ID, allocating it on first ask.
   * `query` is the primitive's semantic identity (its ancestral query); it lands
   * on the registry record either way, only the *uniqueness* key differs.
   *
   * Memoized per index because faces and edges ask once per triangle/segment.
   * Vertices ask exactly once each, so for them the memo never hits -- one Map
   * write per vertex, far cheaper than keeping a second allocation path alive.
   */
  rgbFor(idx: number, query: string): [number, number, number] {
    const cached = this.rgbByIndex.get(idx)
    if (cached) return cached
    const rgb = idToRGBNormalized(this.idFor(idx, query))
    this.rgbByIndex.set(idx, rgb)
    return rgb
  }

  /**
   * Primitive `idx`'s ID itself, allocating it on first ask. Layers that only
   * need a colour use `rgbFor`; a layer that also has to tell the registry
   * something ABOUT the id -- where its mark landed, say -- needs the number.
   * Memoized alongside the colour so asking for both costs one allocation.
   */
  idFor(idx: number, query: string): number {
    const cached = this.idByIndex.get(idx)
    if (cached !== undefined) return cached
    const id = this.allocate(idx, query)
    this.idByIndex.set(idx, id)
    return id
  }

  private allocate(idx: number, query: string): number {
    // B-rep primitives allocate by a per-primitive pickKey (bodyKey#layer#idx)
    // rather than by the query, so two primitives that share an ancestral query
    // (no minted UUID / shared octant) still resolve to distinct IDs. The query
    // rides along as the record's entityKey for downstream selection. Reusers of
    // these layers leave the flag off because their keys are already unique --
    // which is also why only they can collide, and why the warning sits here.
    //
    // The guard is nearly redundant and kept for the hot path, not for
    // correctness: `warnDuplicateQuery` probes the registry BY QUERY, while a
    // per-primitive pass registers by pickKey, so the probe misses and cannot
    // warn anyway. Skipping it saves one map lookup per b-rep primitive. It can
    // still bite: `face`/`edge`/`vertex` ARE driven in both modes -- per-primitive
    // from the part editor's `use*IdRegistration` hooks, query-keyed from
    // `AssemblyPickLayers` -- so a registry that ever saw both would let the
    // probe hit a per-primitive pass on the other editor's query.
    if (!this.perPrimitive) this.warnDuplicateQuery(query)
    const pickKey = this.perPrimitive
      ? primitivePickKey(this.bodyKey, idx, this.layerName)
      : query
    const id = this.registry.allocate(this.layerName, query, pickKey)
    this.ids.add(id)
    return id
  }

  /**
   * Dev-only diagnostic: warn once when two primitives of the same body resolve
   * to one query string, which in query-keyed mode collapses them onto a single
   * ID. Requiring at least one earlier allocation in this body is what keeps the
   * legitimate cross-body case quiet -- imprecisely, since from the second
   * primitive on the collision partner may still be another body's.
   *
   * Tagged with the layer NAME, not the class name: FaceIdLayer and EdgeIdLayer
   * are each reused under several layer names (sketch surfaces, feature handles),
   * so the instance is the part you cannot otherwise tell -- the class is already
   * implied by the primitive name.
   */
  private warnDuplicateQuery(query: string): void {
    if (import.meta.env?.MODE === 'production') return
    if (this.ids.size === 0) return
    if (this.registry.lookupKey(this.layerName, query) === undefined) return
    const dedupKey = `${this.layerName}\x00${query}`
    if (_warnedDuplicates.has(dedupKey)) return
    _warnedDuplicates.add(dedupKey)
    console.warn(
      `[${this.layerName}] Two ${this.plural} share the same query string in ${this.bodyKey}. ` +
      `query="${query}". Selection IDs will not be unique.`
    )
  }
}

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
  // Plural name of the primitive this layer draws, used in dev diagnostics.
  protected abstract readonly primitiveNounPlural: string
  constructor(registry: IdRegistry) { this.registry = registry }

  unregisterBody(bodyKey: string): void {
    const rec = this.bodies.get(bodyKey)
    if (!rec) return
    this.scene.remove(rec.mesh)
    rec.geometry.dispose()
    for (const id of rec.allocatedIds) this.registry.free(id)
    this.bodies.delete(bodyKey)
  }

  // Test helper: number of registered bodies.
  bodyCount(): number { return this.bodies.size }

  /** Drop every registered body's GPU resources; call from a subclass `dispose`
   *  before disposing the layer's own materials. */
  protected disposeBodies(): void {
    for (const key of [...this.bodies.keys()]) this.unregisterBody(key)
  }

  /**
   * Open ID allocation for one body; see `PrimitiveIdAllocator`. Called at the
   * top of each subclass's `registerBody`, after the `unregisterBody` pre-clear
   * that frees whatever the previous pass over this body took.
   */
  protected primitiveIds(bodyKey: string, perPrimitivePickKeys: boolean | undefined): PrimitiveIdAllocator {
    return new PrimitiveIdAllocator(this.registry, this.name, this.primitiveNounPlural, bodyKey, perPrimitivePickKeys)
  }

  abstract dispose(): void
}
