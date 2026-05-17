import * as THREE from 'three'
import { IdLayerBase, type LayerZPolicy } from './IdLayer'
import type { IdRegistry } from './IdRegistry'
import { idToRGBNormalized } from './idEncoding'

/**
 * Concrete ID layer for B-rep vertices.
 *
 * Each registered body becomes one instanced mesh: a unit quad expanded
 * in the vertex shader to `VERTEX_FAT_PIXELS` on screen, regardless of
 * camera zoom. Per-instance attributes carry the vertex center (world
 * space) and the packed vertex ID as a normalized RGB color.
 *
 * Depth: `zPolicy = 'no-depth'` (the pipeline clears depth before this
 * layer), and the material itself runs `depthTest = false` so vertices
 * always win where they draw -- matching the architecture's "vertex
 * wins over edge wins over face" priority via geometric layering.
 */
export const VERTEX_LAYER_NAME = 'vertex'
export const VERTEX_FAT_PIXELS = 16

export interface VertexBodyRegistration {
  bodyKey: string
  vertices: ReadonlyArray<[number, number, number]>
  vertexQueries: ReadonlyArray<string>
}

interface BodyRecord {
  mesh: THREE.InstancedMesh
  geometry: THREE.BufferGeometry
  allocatedIds: number[]
}

const VERT_SHADER = `
  attribute vec3 aCenter;
  attribute vec3 aColor;
  uniform vec2 uViewport;   // pixels (W, H)
  uniform float uFatPixels;
  varying vec3 vColor;

  void main() {
    // 'position' is the unit-quad corner in [-1, 1]. We treat that as a
    // pixel-space offset (uFatPixels each direction) and convert to clip
    // space via 1/half-viewport, so the quad is a true square in pixels
    // even on non-square viewports.
    vec4 clipCenter = projectionMatrix * modelViewMatrix * vec4(aCenter, 1.0);
    vec2 half = uViewport * 0.5;
    vec2 offsetPx = position.xy * uFatPixels;
    vec2 offsetClip = (offsetPx / half) * clipCenter.w;
    clipCenter.xy += offsetClip;
    vColor = aColor;
    gl_Position = clipCenter;
  }
`

const FRAG_SHADER = `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`

function buildVertexIdMaterial(): THREE.ShaderMaterial {
  // depthTest:false is the load-bearing setting here -- combined with
  // priority=20 it means a vertex pixel always wins over any face/edge
  // pixel under it, which is the "vertex beats edge beats face" rule
  // expressed geometrically rather than in a resolver priority sort.
  return new THREE.ShaderMaterial({
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    uniforms: {
      uViewport:  { value: new THREE.Vector2(1, 1) },
      uFatPixels: { value: VERTEX_FAT_PIXELS },
    },
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  })
}

/** A non-instanced unit quad in [-1,1]^2 lying in z=0, two triangles. */
function buildUnitQuadGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array([
    -1, -1, 0,
     1, -1, 0,
     1,  1, 0,
    -1, -1, 0,
     1,  1, 0,
    -1,  1, 0,
  ])
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  return geo
}

export class VertexIdLayer extends IdLayerBase {
  readonly name = VERTEX_LAYER_NAME
  readonly priority = 20
  readonly zPolicy: LayerZPolicy = 'no-depth'
  inertWhen?: () => boolean

  private bodies = new Map<string, BodyRecord>()
  private material = buildVertexIdMaterial()
  private lastWidth = 0
  private lastHeight = 0

  constructor(registry: IdRegistry) {
    super(registry)
  }

  registerBody(reg: VertexBodyRegistration): void {
    this.unregisterBody(reg.bodyKey)
    const { vertices, vertexQueries } = reg
    const count = vertices.length
    if (count === 0) return

    const geometry = buildUnitQuadGeometry()
    const centers = new Float32Array(count * 3)
    const colors  = new Float32Array(count * 3)
    const allocatedIds: number[] = []

    let written = 0
    for (let i = 0; i < count; i++) {
      const query = vertexQueries[i]
      if (query === undefined) continue
      const id = this.registry.allocate(this.name, query)
      allocatedIds.push(id)
      const [r, g, b] = idToRGBNormalized(id)
      const v = vertices[i]
      const base = written * 3
      centers[base]     = v[0]
      centers[base + 1] = v[1]
      centers[base + 2] = v[2]
      colors[base]      = r
      colors[base + 1]  = g
      colors[base + 2]  = b
      written++
    }

    if (written === 0) {
      geometry.dispose()
      return
    }

    // Slice if some vertices had no query.
    const finalCenters = written === count ? centers : centers.subarray(0, written * 3)
    const finalColors  = written === count ? colors  : colors.subarray(0, written * 3)

    geometry.setAttribute('aCenter', new THREE.InstancedBufferAttribute(finalCenters, 3))
    geometry.setAttribute('aColor',  new THREE.InstancedBufferAttribute(finalColors,  3))

    const mesh = new THREE.InstancedMesh(geometry, this.material, written)
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
  }
}
