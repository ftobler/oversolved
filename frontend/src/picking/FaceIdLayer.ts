import * as THREE from 'three'
import { IdLayerBase, type LayerZPolicy } from './IdLayer'
import type { IdRegistry } from './IdRegistry'
import { idToRGBNormalized } from './idEncoding'
import { FACE_LAYER_NAME } from './layerNames'
import { primitivePickKey } from './pickKey'

/**
 * Concrete ID layer for B-rep faces.
 *
 * Each registered body becomes one Mesh in the layer's scene. Per-vertex
 * `color` carries the packed face ID as normalized RGB; the shader passes
 * it straight through to the fragment output (alpha = 1 so the alpha
 * channel acts as the "occupied" flag).
 *
 * Vertices are expected to be non-indexed (one triangle = 3 unique
 * vertices), matching the layout `Body3D` already builds via
 * `buildBodyGeometry(mesh).toNonIndexed()`. Each triangle's 3 vertex
 * colors are identical -- the face ID.
 */
export { FACE_LAYER_NAME }

export interface FaceIdLayerConfig {
  name?: string
  priority?: number
  zPolicy?: LayerZPolicy
}

export interface FaceBodyRegistration {
  /** Stable key for the registered body (e.g. `${featureId}/${bodyId}`). */
  bodyKey: string
  /** Non-indexed triangle positions, length = numTris * 9. */
  positions: Float32Array
  /** Per-triangle B-rep face index (length = numTris). */
  triangleToFace: Uint32Array | number[]
  /** Ancestral query per B-rep face (indexed by face index). */
  faceQueries: ReadonlyArray<string>
  /**
   * When true, allocate the ID by a per-primitive key (`bodyKey#faceIdx`) rather
   * than by the query string. B-rep faces set this because their queries can
   * legitimately collide (no minted UUID / shared octant); other reusers of this
   * layer (sketch surfaces) have unique keys and leave it off.
   */
  perPrimitivePickKeys?: boolean
}

const VERT_SHADER = `
  varying vec3 vColor;
  void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG_SHADER = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`

function buildFaceIdMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
}

export class FaceIdLayer extends IdLayerBase<THREE.Mesh> {
  readonly name: string
  readonly priority: number
  readonly zPolicy: LayerZPolicy
  inertWhen?: () => boolean

  private material = buildFaceIdMaterial()

  constructor(registry: IdRegistry, config?: FaceIdLayerConfig) {
    super(registry)
    this.name = config?.name ?? FACE_LAYER_NAME
    this.priority = config?.priority ?? 0
    this.zPolicy = config?.zPolicy ?? 'clear-then-fresh'
  }

  registerBody(reg: FaceBodyRegistration): void {
    // If already registered under this key, replace (geometry may have changed).
    this.unregisterBody(reg.bodyKey)

    const { positions, triangleToFace, faceQueries } = reg
    if (positions.length % 9 !== 0) {
      throw new Error(`FaceIdLayer: positions length ${positions.length} is not a multiple of 9`)
    }
    const numTris = positions.length / 9

    const colors = new Float32Array(numTris * 9)
    const allocatedIds: number[] = []
    const faceIdCache = new Map<number, [number, number, number]>()

    for (let tri = 0; tri < numTris; tri++) {
      const faceIdx = triangleToFace[tri] ?? 0
      const query = faceQueries[faceIdx]
      if (query === undefined) continue  // skip triangles without a stable face query

      let rgb = faceIdCache.get(faceIdx)
      if (!rgb) {
        // B-rep faces: allocate by a per-primitive pickKey (bodyKey#faceIdx), not
        // the query, so two faces that share an ancestral query (no minted UUID /
        // shared octant) still resolve to distinct IDs. The query rides along as
        // the record's entityKey for downstream selection/resolution. Other layers
        // keep the legacy query-keyed allocation (their keys are already unique).
        let id: number
        if (reg.perPrimitivePickKeys) {
          id = this.registry.allocate(this.name, query, primitivePickKey(reg.bodyKey, faceIdx, this.name))
        } else {
          this.warnDuplicateQuery(query, faceIdCache.size > 0, reg.bodyKey, 'FaceIdLayer', 'face')
          id = this.registry.allocate(this.name, query)
        }
        allocatedIds.push(id)
        rgb = idToRGBNormalized(id)
        faceIdCache.set(faceIdx, rgb)
      }

      const base = tri * 9
      for (let v = 0; v < 3; v++) {
        colors[base + v * 3]     = rgb[0]
        colors[base + v * 3 + 1] = rgb[1]
        colors[base + v * 3 + 2] = rgb[2]
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const mesh = new THREE.Mesh(geometry, this.material)
    mesh.frustumCulled = false
    this.scene.add(mesh)

    this.bodies.set(reg.bodyKey, { mesh, geometry, allocatedIds })
  }

  dispose(): void {
    this.disposeBodies()
    this.material.dispose()
  }
}
