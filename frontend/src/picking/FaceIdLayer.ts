import * as THREE from 'three'
import { IdLayerBase, type LayerZPolicy } from './IdLayer'
import type { IdRegistry } from './IdRegistry'
import { FACE_LAYER_NAME } from './layerNames'

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
  // Stable key for the registered body (e.g. `${featureId}/${bodyId}`).
  bodyKey: string
  // Non-indexed triangle positions, length = numTris * 9.
  positions: Float32Array
  // Per-triangle B-rep face index (length = numTris).
  triangleToFace: Uint32Array | number[]
  // Ancestral query per B-rep face (indexed by face index).
  faceQueries: ReadonlyArray<string>
  /**
   * When true, allocate the ID by a per-primitive key (`bodyKey#layer#faceIdx`)
   * rather than by the query string. B-rep faces set this because their queries can
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
  protected readonly primitiveNounPlural = 'faces'

  private material = buildFaceIdMaterial()

  constructor(registry: IdRegistry, config?: FaceIdLayerConfig) {
    super(registry)
    this.name = config?.name ?? FACE_LAYER_NAME
    this.priority = config?.priority ?? 0
    this.zPolicy = config?.zPolicy ?? 'clear-then-fresh'
  }

  registerBody(reg: FaceBodyRegistration): void {
    const { positions, triangleToFace, faceQueries } = reg
    if (positions.length % 9 !== 0) {
      throw new Error(`FaceIdLayer: positions length ${positions.length} is not a multiple of 9`)
    }
    const numTris = positions.length / 9
    // Fail loud BEFORE touching scene or registry: a map shorter than the
    // triangle count used to fall through the `?? 0` default and silently
    // recolor those triangles with face 0's id.
    if (triangleToFace.length < numTris) {
      throw new Error(`FaceIdLayer: triangleToFace length ${triangleToFace.length} is shorter than the ${numTris} registered triangles`)
    }

    // If already registered under this key, replace (geometry may have changed).
    this.unregisterBody(reg.bodyKey)

    const ids = this.primitiveIds(reg.bodyKey, reg.perPrimitivePickKeys)
    try {
      const drawable: number[] = []
      for (let tri = 0; tri < numTris; tri++) {
        const base = tri * 9
        let finite = true
        for (let i = 0; i < 9; i++) {
          if (!Number.isFinite(positions[base + i])) { finite = false; break }
        }
        // A triangle that cannot be named (its face has no stable query) or
        // whose positions are non-finite is EXCLUDED from the drawn geometry:
        // drawn black it would decode to EMPTY_ID while still writing depth,
        // occluding real picks behind it. Collapsed tessellation output is the
        // usual source of both.
        if (finite && faceQueries[triangleToFace[tri]] !== undefined) drawable.push(tri)
      }

      const drawn = drawable.length
      // Zero-copy fast path when every triangle draws (the common case).
      const outPositions = drawn === numTris ? positions : new Float32Array(drawn * 9)
      const colors = new Float32Array(drawn * 9)

      for (let d = 0; d < drawn; d++) {
        const tri = drawable[d]
        const faceIdx = triangleToFace[tri]
        const query = faceQueries[faceIdx]

        // Every triangle of a face carries that face's ID, so the allocator is
        // asked per triangle and answers from its memo after the first one.
        const rgb = ids.rgbFor(faceIdx, query)

        const src = tri * 9
        if (outPositions !== positions) outPositions.set(positions.subarray(src, src + 9), d * 9)
        for (let v = 0; v < 3; v++) {
          colors[d * 9 + v * 3]     = rgb[0]
          colors[d * 9 + v * 3 + 1] = rgb[1]
          colors[d * 9 + v * 3 + 2] = rgb[2]
        }
      }

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(outPositions, 3))
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

      const mesh = new THREE.Mesh(geometry, this.material)
      mesh.frustumCulled = false
      this.scene.add(mesh)

      this.bodies.set(reg.bodyKey, { mesh, geometry, allocatedIds: ids.allocatedIds })
    } catch (err) {
      // A mid-loop allocation failure (24-bit ID exhaustion) must not leak the
      // ids already taken for this pass.
      for (const id of ids.allocatedIds) this.registry.free(id)
      throw err
    }
  }

  dispose(): void {
    this.disposeBodies()
    this.material.dispose()
  }
}
