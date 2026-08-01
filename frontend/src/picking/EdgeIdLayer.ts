import * as THREE from 'three'
import { IdLayerBase, type LayerZPolicy } from './IdLayer'
import type { IdRegistry } from './IdRegistry'
import { EDGE_LAYER_NAME } from './layerNames'

/**
 * Concrete ID layer for B-rep edges.
 *
 * Each segment of every registered edge is drawn as a 1-pixel line via
 * LineSegments. The ID buffer's windowed resolver (default 17px) provides
 * the snap radius, so fattened ribbons are unnecessary -- a thin line
 * at the exact geometry edge is plenty wide for picking.
 *
 * Depth policy: the layer's zPolicy is 'depth-test-against-prev' (no
 * clearDepth before render), and the material runs `depthTest = true`
 * with `depthWrite = false` so edges are culled by faces but don't
 * occlude each other. A `uXrayEdges` uniform flips depth testing off
 * for the future "select hidden edges" tool mode (#267).
 *
 * A small clip-space depth bias is applied so edges lying on a face
 * surface don't z-fight with the face into oblivion.
 */
export { EDGE_LAYER_NAME }
export const EDGE_DEPTH_BIAS = -1e-4

export interface EdgeIdLayerConfig {
  name?: string
  priority?: number
  zPolicy?: LayerZPolicy
  depthBias?: number
  depthTest?: boolean
  depthWrite?: boolean
}

export interface EdgeBodyRegistration {
  // Stable key, e.g. `${featureId}/${bodyId}`.
  bodyKey: string
  // Flat segment positions (pairs of endpoints), length = 2 * numSegments * 3.
  segmentPositions: Float32Array
  // Per-segment edge index.
  segmentToEdge: Uint32Array | number[]
  // Ancestral query per edge (length = numEdges).
  edgeQueries: ReadonlyArray<string>
  /**
   * When true, allocate the ID by a per-primitive key (`bodyKey#layer#edgeIdx`)
   * rather than by the query string. B-rep edges set this because their queries can
   * legitimately collide (no minted UUID / shared octant); other reusers of this
   * layer (feature handles, sketch composites) have unique keys and leave it off.
   */
  perPrimitivePickKeys?: boolean
}

const VERT_SHADER = `
  attribute vec3 aColor;
  uniform float uDepthBias;
  varying vec3 vColor;

  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    clip.z += uDepthBias * clip.w;
    vColor = aColor;
    gl_Position = clip;
  }
`

const FRAG_SHADER = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`

function buildEdgeIdMaterial(opts?: { depthBias?: number; depthTest?: boolean; depthWrite?: boolean }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    uniforms: {
      uDepthBias: { value: opts?.depthBias ?? EDGE_DEPTH_BIAS },
    },
    depthTest: opts?.depthTest ?? true,
    depthWrite: opts?.depthWrite ?? false,
  })
}

function buildXrayMaterialFrom(base: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const m = base.clone()
  m.depthTest = false
  m.uniforms = base.uniforms
  return m
}

export class EdgeIdLayer extends IdLayerBase<THREE.LineSegments> {
  readonly name: string
  readonly priority: number
  readonly zPolicy: LayerZPolicy
  inertWhen?: () => boolean
  protected readonly primitiveNounPlural = 'edges'

  private material: THREE.ShaderMaterial
  private xrayMaterial: THREE.ShaderMaterial
  private xrayEnabled = false

  constructor(registry: IdRegistry, config?: EdgeIdLayerConfig) {
    super(registry)
    this.name = config?.name ?? EDGE_LAYER_NAME
    this.priority = config?.priority ?? 10
    this.zPolicy = config?.zPolicy ?? 'depth-test-against-prev'
    this.material = buildEdgeIdMaterial({
      depthBias: config?.depthBias,
      depthTest: config?.depthTest,
      depthWrite: config?.depthWrite,
    })
    this.xrayMaterial = buildXrayMaterialFrom(this.material)
  }

  // Toggle x-ray mode: when true, edges hidden behind faces are still pickable.
  setXrayEdges(enabled: boolean): void {
    if (this.xrayEnabled === enabled) return
    this.xrayEnabled = enabled
    const mat = enabled ? this.xrayMaterial : this.material
    for (const rec of this.bodies.values()) rec.mesh.material = mat
  }

  isXrayEdges(): boolean { return this.xrayEnabled }

  registerBody(reg: EdgeBodyRegistration): void {
    this.unregisterBody(reg.bodyKey)
    const { segmentPositions, segmentToEdge, edgeQueries } = reg

    if (segmentPositions.length % 6 !== 0) {
      throw new Error(`EdgeIdLayer: segmentPositions length ${segmentPositions.length} is not a multiple of 6`)
    }
    const numSegments = segmentPositions.length / 6
    if (numSegments === 0) return

    // 2 vertices per segment (a line), 3 floats per vertex.
    const positions = new Float32Array(numSegments * 2 * 3)
    const colors    = new Float32Array(numSegments * 2 * 3)

    const ids = this.primitiveIds(reg.bodyKey, reg.perPrimitivePickKeys)

    for (let seg = 0; seg < numSegments; seg++) {
      const baseSeg = seg * 6
      const sx = segmentPositions[baseSeg]
      const sy = segmentPositions[baseSeg + 1]
      const sz = segmentPositions[baseSeg + 2]
      const ex = segmentPositions[baseSeg + 3]
      const ey = segmentPositions[baseSeg + 4]
      const ez = segmentPositions[baseSeg + 5]

      const edgeIdx = segmentToEdge[seg] ?? 0
      const query = edgeQueries[edgeIdx]
      if (query === undefined) continue

      // Every segment of a polyline-approximated edge carries that edge's ID, so
      // the allocator is asked per segment and answers from its memo after the first.
      const rgb = ids.rgbFor(edgeIdx, query)

      const base2 = seg * 6  // 2 vertices * 3 components
      positions[base2]     = sx; positions[base2 + 1] = sy; positions[base2 + 2] = sz
      positions[base2 + 3] = ex; positions[base2 + 4] = ey; positions[base2 + 5] = ez
      colors[base2]     = rgb[0]; colors[base2 + 1] = rgb[1]; colors[base2 + 2] = rgb[2]
      colors[base2 + 3] = rgb[0]; colors[base2 + 4] = rgb[1]; colors[base2 + 5] = rgb[2]
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3))

    const mat = this.xrayEnabled ? this.xrayMaterial : this.material
    const mesh = new THREE.LineSegments(geometry, mat)
    mesh.frustumCulled = false
    this.scene.add(mesh)
    this.bodies.set(reg.bodyKey, { mesh, geometry, allocatedIds: ids.allocatedIds })
  }

  dispose(): void {
    this.disposeBodies()
    this.material.dispose()
    this.xrayMaterial.dispose()
  }
}
