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
  /** Dispose all GPU resources owned by the layer. */
  dispose(): void
}

/**
 * Convenience base: owns a registry reference + a private Scene that
 * concrete layers populate. Subclasses implement the actual registration
 * surface (e.g. FaceIdLayer.registerBody).
 */
export abstract class IdLayerBase implements IdLayer {
  abstract readonly name: string
  abstract readonly priority: number
  abstract readonly zPolicy: LayerZPolicy
  readonly scene: THREE.Scene = new THREE.Scene()

  protected registry: IdRegistry
  constructor(registry: IdRegistry) { this.registry = registry }

  abstract dispose(): void
}
