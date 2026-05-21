import * as THREE from 'three'
import { IdLayerBase, type LayerZPolicy } from './IdLayer'
import type { IdRegistry } from './IdRegistry'
import { idToRGBNormalized } from './idEncoding'

const _warnedDuplicates = new Set<string>()

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
export const FACE_LAYER_NAME = 'face'

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
}

interface BodyRecord {
  mesh: THREE.Mesh
  geometry: THREE.BufferGeometry
  allocatedIds: number[]
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

export class FaceIdLayer extends IdLayerBase {
  readonly name: string
  readonly priority: number
  readonly zPolicy: LayerZPolicy
  inertWhen?: () => boolean

  private bodies = new Map<string, BodyRecord>()
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
        if (process.env.NODE_ENV !== 'production') {
          const dedupKey = `${this.name}\x00${query}`
          if (this.registry.lookupKey(this.name, query) !== undefined && faceIdCache.size > 0 && !_warnedDuplicates.has(dedupKey)) {
            _warnedDuplicates.add(dedupKey)
            console.warn(
              `[FaceIdLayer] Two faces share the same query string in ${reg.bodyKey}. ` +
              `query="${query}". Selection IDs will not be unique.`
            )
          }
        }
        const id = this.registry.allocate(this.name, query)
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

  unregisterBody(bodyKey: string): void {
    const rec = this.bodies.get(bodyKey)
    if (!rec) return
    this.scene.remove(rec.mesh)
    rec.geometry.dispose()
    for (const id of rec.allocatedIds) this.registry.free(id)
    this.bodies.delete(bodyKey)
  }

  /** Test helper: number of registered bodies. */
  bodyCount(): number {
    return this.bodies.size
  }

  dispose(): void {
    for (const key of [...this.bodies.keys()]) this.unregisterBody(key)
    this.material.dispose()
  }
}
