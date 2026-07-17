import * as THREE from 'three'
import { IdLayerBase, type LayerZPolicy } from './IdLayer'
import type { IdRegistry } from './IdRegistry'
import { idToRGBNormalized } from './idEncoding'
import { VERTEX_LAYER_NAME } from './layerNames'
import { primitivePickKey } from './pickKey'

/**
 * Concrete ID layer for B-rep vertices.
 *
 * Each registered body becomes one THREE.Points with per-vertex ID colors.
 * The ID buffer's windowed resolver (default 17px) provides the snap radius,
 * so only 1-pixel points are needed -- no fattened quads required.
 *
 * Depth: `zPolicy = 'no-depth'` (the pipeline clears depth before this
 * layer), and the material itself runs `depthTest = false` so vertices
 * always win where they draw -- matching the architecture's "vertex
 * wins over edge wins over face" priority via geometric layering.
 */
export { VERTEX_LAYER_NAME }
export interface VertexIdLayerConfig {
  name?: string
  priority?: number
  zPolicy?: LayerZPolicy
}

export interface VertexBodyRegistration {
  bodyKey: string
  vertices: ReadonlyArray<[number, number, number]>
  vertexQueries: ReadonlyArray<string>
  /**
   * When true, allocate the ID by a per-primitive key (`bodyKey#vertexIdx`)
   * rather than by the query string. B-rep vertices set this because their
   * queries can legitimately collide (no minted UUID / shared octant); other
   * reusers with unique keys leave it off. Mirrors FaceIdLayer / EdgeIdLayer.
   */
  perPrimitivePickKeys?: boolean
}

const VERT_SHADER = `
  attribute vec3 aColor;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG_SHADER = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`

function buildVertexIdMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    depthTest: false,
    depthWrite: false,
  })
}

export class VertexIdLayer extends IdLayerBase<THREE.Points> {
  readonly name: string
  readonly priority: number
  readonly zPolicy: LayerZPolicy
  inertWhen?: () => boolean

  private material = buildVertexIdMaterial()

  constructor(registry: IdRegistry, _config?: VertexIdLayerConfig) {
    super(registry)
    this.name = _config?.name ?? VERTEX_LAYER_NAME
    this.priority = _config?.priority ?? 20
    this.zPolicy = _config?.zPolicy ?? 'no-depth'
  }

  registerBody(reg: VertexBodyRegistration): void {
    this.unregisterBody(reg.bodyKey)
    const { vertices, vertexQueries } = reg
    const count = vertices.length
    if (count === 0) return

    const positions = new Float32Array(count * 3)
    const colors    = new Float32Array(count * 3)
    const allocatedIds: number[] = []

    let written = 0
    for (let i = 0; i < count; i++) {
      const query = vertexQueries[i]
      if (query === undefined) continue
      // Per-primitive pick key so two vertices sharing a query still get distinct
      // ids; the query rides along as the record's entityKey (mirrors edges/faces).
      const id = reg.perPrimitivePickKeys
        ? this.registry.allocate(this.name, query, primitivePickKey(reg.bodyKey, i, this.name))
        : this.registry.allocate(this.name, query)
      allocatedIds.push(id)
      const [r, g, b] = idToRGBNormalized(id)
      const v = vertices[i]
      const base = written * 3
      positions[base]     = v[0]
      positions[base + 1] = v[1]
      positions[base + 2] = v[2]
      colors[base]      = r
      colors[base + 1]  = g
      colors[base + 2]  = b
      written++
    }

    if (written === 0) return

    const geometry = new THREE.BufferGeometry()
    const finalPositions = written === count ? positions : positions.subarray(0, written * 3)
    const finalColors    = written === count ? colors    : colors.subarray(0, written * 3)
    geometry.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3))
    geometry.setAttribute('aColor',   new THREE.BufferAttribute(finalColors,     3))

    const mesh = new THREE.Points(geometry, this.material)
    mesh.frustumCulled = false
    this.scene.add(mesh)
    this.bodies.set(reg.bodyKey, { mesh, geometry, allocatedIds })
  }

  dispose(): void {
    this.disposeBodies()
    this.material.dispose()
  }
}
