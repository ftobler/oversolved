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
 * occlude each other. `setXrayEdges(true)` swaps in a second material
 * cloned with `depthTest = false` for the future "select hidden edges"
 * tool mode (#267).
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

// Writes the packed id straight to the RGBA8 pick target: NO tone mapping and
// NO output-colorspace encoding, on purpose. The pick buffer must hold the
// exact bytes the id encodes. The visible wireframe shader (edgeLineMaterial.ts)
// is the mirror image and DOES apply both transforms.
export const EDGE_ID_FRAG_SHADER = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`

function buildEdgeIdMaterial(opts?: { depthBias?: number; depthTest?: boolean; depthWrite?: boolean }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT_SHADER,
    fragmentShader: EDGE_ID_FRAG_SHADER,
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
    const { segmentPositions, segmentToEdge, edgeQueries } = reg

    if (segmentPositions.length % 6 !== 0) {
      throw new Error(`EdgeIdLayer: segmentPositions length ${segmentPositions.length} is not a multiple of 6`)
    }
    const numSegments = segmentPositions.length / 6
    // Fail loud BEFORE touching scene or registry: an out-of-range read used to
    // fall through the `?? 0` default and silently attribute those segments to
    // edge 0.
    if (segmentToEdge.length < numSegments) {
      throw new Error(`EdgeIdLayer: segmentToEdge length ${segmentToEdge.length} is shorter than the ${numSegments} registered segments`)
    }

    this.unregisterBody(reg.bodyKey)
    // A re-register with zero segments still replaces (not silently keeps) the
    // old body's registration.
    if (numSegments === 0) return

    // 2 vertices per segment (a line), 3 floats per vertex.
    const ids = this.primitiveIds(reg.bodyKey, reg.perPrimitivePickKeys)
    try {
      const drawable: number[] = []
      for (let seg = 0; seg < numSegments; seg++) {
        const baseSeg = seg * 6
        let finite = true
        for (let i = 0; i < 6; i++) {
          if (!Number.isFinite(segmentPositions[baseSeg + i])) { finite = false; break }
        }
        // A segment that cannot be named (its edge has no stable query) or
        // whose endpoints are non-finite is EXCLUDED from the drawn geometry:
        // drawn black it would decode to EMPTY_ID while still rasterising over
        // real picks.
        if (finite && edgeQueries[segmentToEdge[seg]] !== undefined) drawable.push(seg)
      }

      const drawn = drawable.length
      // Every segment was filtered out (all unnamed or non-finite): add nothing
      // to the scene so the pipeline's empty-layer skip (scene.children.length
      // === 0) holds. The unregister pre-clear and the numSegments === 0 exit
      // above already handled the other empty cases.
      if (drawn === 0) return
      // Zero-copy fast path when every segment draws (the common case).
      const outPositions = drawn === numSegments ? segmentPositions : new Float32Array(drawn * 6)
      const colors = new Float32Array(drawn * 6)

      for (let d = 0; d < drawn; d++) {
        const seg = drawable[d]
        const baseSeg = seg * 6
        const edgeIdx = segmentToEdge[seg]
        const query = edgeQueries[edgeIdx]

        // Every segment of a polyline-approximated edge carries that edge's ID,
        // so the allocator is asked per segment and answers from its memo after
        // the first.
        const rgb = ids.rgbFor(edgeIdx, query)

        const dst = d * 6
        if (outPositions !== segmentPositions) outPositions.set(segmentPositions.subarray(baseSeg, baseSeg + 6), dst)
        colors[dst]     = rgb[0]; colors[dst + 1] = rgb[1]; colors[dst + 2] = rgb[2]
        colors[dst + 3] = rgb[0]; colors[dst + 4] = rgb[1]; colors[dst + 5] = rgb[2]
      }

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(outPositions, 3))
      geometry.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3))

      const mat = this.xrayEnabled ? this.xrayMaterial : this.material
      const mesh = new THREE.LineSegments(geometry, mat)
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
    this.xrayMaterial.dispose()
  }
}
