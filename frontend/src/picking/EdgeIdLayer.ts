import * as THREE from 'three'
import { IdLayerBase, type LayerZPolicy } from './IdLayer'
import type { IdRegistry } from './IdRegistry'
import { idToRGBNormalized } from './idEncoding'

/**
 * Concrete ID layer for B-rep edges.
 *
 * Each segment of every registered edge is expanded into a screen-space
 * ribbon (two triangles, 6 vertices) by a vertex shader. The fragment
 * shader emits the packed edge ID as RGB, alpha = 1.
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
export const EDGE_LAYER_NAME = 'edge'
export const EDGE_FAT_PIXELS = 8
export const EDGE_DEPTH_BIAS = -1e-4

export interface EdgeIdLayerConfig {
  name?: string
  priority?: number
  zPolicy?: LayerZPolicy
  fatPixels?: number
  depthBias?: number
  depthTest?: boolean
  depthWrite?: boolean
}

export interface EdgeBodyRegistration {
  /** Stable key, e.g. `${featureId}/${bodyId}`. */
  bodyKey: string
  /** Flat segment positions (pairs of endpoints), length = 2 * numSegments * 3. */
  segmentPositions: Float32Array
  /** Per-segment edge index. */
  segmentToEdge: Uint32Array | number[]
  /** Ancestral query per edge (length = numEdges). */
  edgeQueries: ReadonlyArray<string>
}

interface BodyRecord {
  mesh: THREE.Mesh
  geometry: THREE.BufferGeometry
  allocatedIds: number[]
}

const VERT_SHADER = `
  attribute vec3 aOther;
  attribute float aSide;
  attribute vec3 aColor;
  uniform vec2 uViewport;   // pixels (W, H) of the ID render target
  uniform float uFatPixels;
  uniform float uDepthBias;
  varying vec3 vColor;

  void main() {
    vec4 clip0 = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 clip1 = projectionMatrix * modelViewMatrix * vec4(aOther,   1.0);

    // Compute tangent in PIXEL space so the perpendicular stays isotropic
    // on non-square viewports. Without this, scaling the NDC normal by
    // (2/W, 2/H) componentwise distorts the ribbon (wider along the long
    // axis). Convert NDC -> pixels, take perp there, then convert back.
    vec2 halfPx = uViewport * 0.5;
    vec2 ndc0 = clip0.xy / max(clip0.w, 1e-6);
    vec2 ndc1 = clip1.xy / max(clip1.w, 1e-6);
    vec2 px0 = ndc0 * halfPx;
    vec2 px1 = ndc1 * halfPx;
    vec2 dirPx = px1 - px0;
    float lenPx = length(dirPx);
    vec2 tangentPx = lenPx > 1e-6 ? dirPx / lenPx : vec2(1.0, 0.0);
    vec2 normalPx = vec2(-tangentPx.y, tangentPx.x);
    vec2 offsetPx = normalPx * (uFatPixels * aSide);
    // pixels -> clip-space delta (cancel the perspective divide via *w).
    vec2 offsetClip = (offsetPx / halfPx) * clip0.w;
    clip0.xy += offsetClip;

    // Negative bias = nudge toward the camera so coplanar face/edge don't z-fight.
    clip0.z += uDepthBias * clip0.w;

    vColor = aColor;
    gl_Position = clip0;
  }
`

const FRAG_SHADER = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`

function buildEdgeIdMaterial(opts?: { fatPixels?: number; depthBias?: number; depthTest?: boolean; depthWrite?: boolean }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    uniforms: {
      uViewport:  { value: new THREE.Vector2(1, 1) },
      uFatPixels: { value: opts?.fatPixels ?? EDGE_FAT_PIXELS },
      uDepthBias: { value: opts?.depthBias ?? EDGE_DEPTH_BIAS },
    },
    side: THREE.DoubleSide,
    depthTest: opts?.depthTest ?? true,
    depthWrite: opts?.depthWrite ?? false,
  })
}

function buildXrayMaterialFrom(base: THREE.ShaderMaterial): THREE.ShaderMaterial {
  // ShaderMaterial.clone() deep-copies uniforms via UniformsUtils.clone().
  // Reassign so both materials share the live uniform objects -- a single
  // uViewport update from onBeforeRender propagates to both materials.
  const m = base.clone()
  m.depthTest = false
  m.uniforms = base.uniforms
  return m
}

export class EdgeIdLayer extends IdLayerBase {
  readonly name: string
  readonly priority: number
  readonly zPolicy: LayerZPolicy
  inertWhen?: () => boolean

  private bodies = new Map<string, BodyRecord>()
  private material: THREE.ShaderMaterial
  private xrayMaterial: THREE.ShaderMaterial
  private xrayEnabled = false
  private lastWidth = 0
  private lastHeight = 0

  constructor(registry: IdRegistry, config?: EdgeIdLayerConfig) {
    super(registry)
    this.name = config?.name ?? EDGE_LAYER_NAME
    this.priority = config?.priority ?? 10
    this.zPolicy = config?.zPolicy ?? 'depth-test-against-prev'
    this.material = buildEdgeIdMaterial({
      fatPixels: config?.fatPixels,
      depthBias: config?.depthBias,
      depthTest: config?.depthTest,
      depthWrite: config?.depthWrite,
    })
    this.xrayMaterial = buildXrayMaterialFrom(this.material)
  }

  /** Toggle x-ray mode: when true, edges hidden behind faces are still pickable. */
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

    // Two triangles per segment, 6 vertices per ribbon.
    // Vertex layout (s = segment start, e = segment end):
    //   v0 = s, side=-1, other=e
    //   v1 = s, side=+1, other=e
    //   v2 = e, side=-1, other=s
    //   v3 = s, side=+1, other=e
    //   v4 = e, side=+1, other=s
    //   v5 = e, side=-1, other=s
    const positions = new Float32Array(numSegments * 6 * 3)
    const others    = new Float32Array(numSegments * 6 * 3)
    const sides     = new Float32Array(numSegments * 6)
    const colors    = new Float32Array(numSegments * 6 * 3)

    const allocatedIds: number[] = []
    const edgeColorCache = new Map<number, [number, number, number]>()

    for (let seg = 0; seg < numSegments; seg++) {
      const base6 = seg * 6
      const baseSegPos = seg * 6
      const sx = segmentPositions[baseSegPos]
      const sy = segmentPositions[baseSegPos + 1]
      const sz = segmentPositions[baseSegPos + 2]
      const ex = segmentPositions[baseSegPos + 3]
      const ey = segmentPositions[baseSegPos + 4]
      const ez = segmentPositions[baseSegPos + 5]

      const edgeIdx = segmentToEdge[seg] ?? 0
      const query = edgeQueries[edgeIdx]
      if (query === undefined) continue

      let rgb = edgeColorCache.get(edgeIdx)
      if (!rgb) {
        const id = this.registry.allocate(this.name, query)
        allocatedIds.push(id)
        rgb = idToRGBNormalized(id)
        edgeColorCache.set(edgeIdx, rgb)
      }

      const setPos = (i: number, x: number, y: number, z: number) => {
        positions[(base6 + i) * 3]     = x
        positions[(base6 + i) * 3 + 1] = y
        positions[(base6 + i) * 3 + 2] = z
      }
      const setOther = (i: number, x: number, y: number, z: number) => {
        others[(base6 + i) * 3]     = x
        others[(base6 + i) * 3 + 1] = y
        others[(base6 + i) * 3 + 2] = z
      }
      const setSide = (i: number, s: number) => { sides[base6 + i] = s }
      const setColor = (i: number, r: number, g: number, b: number) => {
        colors[(base6 + i) * 3]     = r
        colors[(base6 + i) * 3 + 1] = g
        colors[(base6 + i) * 3 + 2] = b
      }

      // Triangle 1: (s,-1), (s,+1), (e,-1)
      setPos(0, sx, sy, sz); setOther(0, ex, ey, ez); setSide(0, -1)
      setPos(1, sx, sy, sz); setOther(1, ex, ey, ez); setSide(1, +1)
      setPos(2, ex, ey, ez); setOther(2, sx, sy, sz); setSide(2, -1)
      // Triangle 2: (s,+1), (e,+1), (e,-1)
      setPos(3, sx, sy, sz); setOther(3, ex, ey, ez); setSide(3, +1)
      setPos(4, ex, ey, ez); setOther(4, sx, sy, sz); setSide(4, +1)
      setPos(5, ex, ey, ez); setOther(5, sx, sy, sz); setSide(5, -1)

      for (let i = 0; i < 6; i++) setColor(i, rgb[0], rgb[1], rgb[2])
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('aOther',   new THREE.BufferAttribute(others, 3))
    geometry.setAttribute('aSide',    new THREE.BufferAttribute(sides, 1))
    geometry.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3))

    const mat = this.xrayEnabled ? this.xrayMaterial : this.material
    const mesh = new THREE.Mesh(geometry, mat)
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

  onBeforeRender(width: number, height: number): void {
    if (width === this.lastWidth && height === this.lastHeight) return
    this.lastWidth = width
    this.lastHeight = height
    const u = this.material.uniforms.uViewport.value as THREE.Vector2
    u.set(Math.max(1, width), Math.max(1, height))
  }

  bodyCount(): number { return this.bodies.size }

  dispose(): void {
    for (const key of [...this.bodies.keys()]) this.unregisterBody(key)
    this.material.dispose()
    this.xrayMaterial.dispose()
  }
}
