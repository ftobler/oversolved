// The ID buffer's side of the section: the B-rep layers clip, the target gains
// a stencil while a section is on, and a cap pass writes the reserved "nothing"
// id over the cut opening so the solid-looking cap cannot pick an interior back
// face. Everything here runs against a recording stand-in renderer, so no GPU
// is involved.
import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { IdPipeline } from '@/picking/IdPipeline'
import { EMPTY_ID, idToRGBNormalized, rgbToId } from '@/picking/idEncoding'
import { IdRegistry } from '@/picking/IdRegistry'
import { IdResolver } from '@/picking/IdResolver'
import { collectEntitiesFromPixels } from '@/picking/collectEntitiesFromPixels'
import { FACE_LAYER_NAME, EDGE_LAYER_NAME } from '@/picking/layerNames'
import { buildEdgeMaterial } from '@/components/Geometry3D/edgeLineMaterial'
import {
  getSectionClipPlane,
  getSectionClipPlaneList,
  resetSectionClippingForTest,
  setSectionClipPlane,
} from '@/viewport/sectionClipping'
import { sectionPlaneFromFrame } from '@/viewport/sectionPlane'

interface RenderRecord {
  scene: THREE.Scene
  material: THREE.Material | null
}

function recordingRenderer(): {
  renderer: THREE.WebGLRenderer
  renders: RenderRecord[]
  stencilClears: number
} {
  const renders: RenderRecord[] = []
  let stencilClears = 0
  const renderer = {
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    autoClear: true,
    getClearColor: () => {},
    getClearAlpha: () => 0,
    setClearColor: () => {},
    clear: (_color: boolean, _depth: boolean, stencil?: boolean) => {
      if (stencil) stencilClears++
    },
    clearDepth: () => {},
    render: (scene: THREE.Scene) => {
      const first = scene.children[0] as THREE.Mesh | undefined
      renders.push({ scene, material: (first?.material as THREE.Material) ?? null })
    },
  } as unknown as THREE.WebGLRenderer
  return { renderer, renders, get stencilClears() { return stencilClears } }
}

function registerBody(p: IdPipeline): void {
  p.faceLayer.registerBody({
    bodyKey: 'b',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    triangleToFace: new Uint32Array([0]),
    faceQueries: ['face@b#0'],
  })
  p.edgeLayer.registerBody({
    bodyKey: 'b',
    segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
    segmentToEdge: new Uint32Array([0]),
    edgeQueries: ['edge@b#0'],
  })
  p.vertexLayer.registerBody({ bodyKey: 'b', vertices: [[0, 0, 0]], vertexQueries: ['vtx@b#0'] })
}

function faceMaterial(p: IdPipeline): THREE.Material {
  return (p.faceLayer.scene.children[0] as THREE.Mesh).material as THREE.Material
}

describe('IdPipeline section clipping', () => {
  beforeEach(() => resetSectionClippingForTest())

  it('clips the face, edge and vertex layers with the shared plane while active', () => {
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0] }, 0, false))
    const p = new IdPipeline({ width: 8, height: 8 })
    registerBody(p)

    p.setSectionActive(true)

    expect(faceMaterial(p).clippingPlanes).toBe(getSectionClipPlaneList())
    expect(p.edgeLayer.isSectionClipped()).toBe(true)
    expect(p.vertexLayer.isSectionClipped()).toBe(true)
    // The reference layers stay unclipped: planes, sketches and handles are
    // what the user reads the cut against.
    expect(p.planeLayer.isSectionClipped()).toBe(false)
    expect(p.sketchSurfaceLayer.isSectionClipped()).toBe(false)
    expect(p.featureHandleLayer.isSectionClipped()).toBe(false)

    p.setSectionActive(false)
    expect(faceMaterial(p).clippingPlanes).toBeNull()
    expect(p.edgeLayer.isSectionClipped()).toBe(false)
    p.dispose()
  })

  it('gives the ID target a stencil only while the section is on, and disposes the old target', () => {
    const p = new IdPipeline({ width: 8, height: 8 })
    expect(p.target.hasStencil()).toBe(false)

    p.setSectionActive(true)
    expect(p.target.hasStencil()).toBe(true)
    const stencilTarget = p.target.target
    const disposed = { called: false }
    stencilTarget.addEventListener('dispose', () => { disposed.called = true })

    p.setSectionActive(false)
    expect(p.target.hasStencil()).toBe(false)
    expect(disposed.called).toBe(true)
    // The size survives the swap.
    expect(p.target.getWidth()).toBe(8)
    expect(p.target.getHeight()).toBe(8)
    p.dispose()
  })

  it('marks the buffer dirty with the section reason on a toggle', () => {
    const p = new IdPipeline({ width: 8, height: 8 })
    p.target.markClean()
    p.setSectionActive(true)
    expect(p.isDirty()).toBe(true)
    expect(p.getLastDirtyReason()).toBe('section')
    p.dispose()
  })
})

describe('IdPipeline section cap occluder', () => {
  beforeEach(() => resetSectionClippingForTest())

  it('runs the stencil count and fills the cap with the nothing id after the face layer', () => {
    setSectionClipPlane(sectionPlaneFromFrame({ normal: [0, 0, 1], point: [0, 0, 0] }, 0, false))
    const p = new IdPipeline({ width: 8, height: 8 })
    registerBody(p)
    p.setSectionActive(true)

    const recorder = recordingRenderer()
    p.markDirty()
    p.render(recorder.renderer, new THREE.Camera())

    // face once normally, then back + front count passes, then the cap quad.
    const faceRenders = recorder.renders.filter(r => r.scene === p.faceLayer.scene)
    expect(faceRenders).toHaveLength(3)
    const countMaterials = faceRenders.slice(1).map(r => r.material as THREE.MeshBasicMaterial)
    expect(countMaterials.map(m => m.stencilFail)).toEqual([
      THREE.IncrementWrapStencilOp,
      THREE.DecrementWrapStencilOp,
    ])
    expect(countMaterials.every(m => m.colorWrite === false)).toBe(true)

    const fillRender = recorder.renders.find((r, i) =>
      i > 0
      && r.scene !== p.faceLayer.scene
      && r.scene !== p.edgeLayer.scene
      && r.scene !== p.vertexLayer.scene)!
    expect(fillRender.scene).not.toBe(p.faceLayer.scene)
    const fill = fillRender.material as THREE.ShaderMaterial
    expect(fill.stencilFunc).toBe(THREE.NotEqualStencilFunc)
    expect(fill.depthWrite).toBe(true)
    // The kept side can present the quad's back face: a FrontSide fill would be
    // culled and the cut opening would stay occupied by interior face ids.
    expect(fill.side).toBe(THREE.DoubleSide)
    // The fill writes zero in every channel, which decodes to the reserved
    // empty id: a pick on the cap answers "nothing", not the bore's far wall.
    expect(fill.fragmentShader).toContain('gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0)')
    expect(rgbToId(0, 0, 0)).toBe(EMPTY_ID)

    // The quad was placed on the live plane before the fill render: its world
    // normal matches the plane's, and its world position is the plane point.
    const quad = fillRender.scene.children[0] as THREE.Mesh
    const plane = getSectionClipPlane()
    const worldRotation = new THREE.Quaternion().setFromRotationMatrix(quad.matrixWorld)
    const worldNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(worldRotation)
    expect(worldNormal.x).toBeCloseTo(plane.normal.x, 9)
    expect(worldNormal.y).toBeCloseTo(plane.normal.y, 9)
    expect(worldNormal.z).toBeCloseTo(plane.normal.z, 9)
    const worldPosition = new THREE.Vector3().setFromMatrixPosition(quad.matrixWorld)
    expect(worldPosition.distanceTo(plane.normal.clone().multiplyScalar(-plane.constant))).toBeLessThan(1e-6)

    // The stencil was cleared before the count and after the fill.
    expect(recorder.stencilClears).toBe(2)
    p.dispose()
  })

  it('runs no cap pass while the section is off', () => {
    const p = new IdPipeline({ width: 8, height: 8 })
    registerBody(p)

    const recorder = recordingRenderer()
    p.markDirty()
    p.render(recorder.renderer, new THREE.Camera())

    expect(recorder.renders.filter(r => r.scene === p.faceLayer.scene)).toHaveLength(1)
    expect(recorder.stencilClears).toBe(0)
    p.dispose()
  })
})

describe('section pick read', () => {
  // The bytes a fake 17x17 read would return: everything empty except one
  // pixel. An empty pixel is what the cap occluder writes, so "the cap picks
  // nothing" is exactly "an empty pixel decodes to no entity".
  const WINDOW = 17
  function pixelBuffer(pixel: { x: number; y: number; rgb: [number, number, number] } | null): Uint8Array {
    const buffer = new Uint8Array(WINDOW * WINDOW * 4)
    if (pixel) {
      const at = (pixel.y * WINDOW + pixel.x) * 4
      buffer[at] = Math.round(pixel.rgb[0] * 255)
      buffer[at + 1] = Math.round(pixel.rgb[1] * 255)
      buffer[at + 2] = Math.round(pixel.rgb[2] * 255)
      buffer[at + 3] = 255
    }
    return buffer
  }

  it('resolves a kept face pixel and nothing on the cap pixel', () => {
    const registry = new IdRegistry()
    const id = registry.allocate(FACE_LAYER_NAME, 'face@b#0', 'face@b#0')
    const resolver = new IdResolver(registry)
    const layerPriority = { [FACE_LAYER_NAME]: 0 }

    const kept = resolver.decode(
      pixelBuffer({ x: 8, y: 8, rgb: idToRGBNormalized(id) }), WINDOW, { layerPriority },
    )
    expect(kept?.entityKey).toBe('face@b#0')

    // The cap writes vec4(0), so the same pixel decodes to no entity: this is
    // the dispatched hover/click answer over the solid-looking cut.
    const cap = resolver.decode(
      pixelBuffer({ x: 8, y: 8, rgb: [0, 0, 0] }), WINDOW, { layerPriority },
    )
    expect(cap).toBeNull()
    expect(rgbToId(0, 0, 0)).toBe(EMPTY_ID)
  })

  it('leaves a rubber band with only the kept edge, because the cap pixel names nothing', () => {
    const registry = new IdRegistry()
    const edgeId = registry.allocate(EDGE_LAYER_NAME, 'edge@b#0', 'edge@b#0')
    const rgb = idToRGBNormalized(edgeId)
    const buffer = pixelBuffer({ x: 8, y: 8, rgb })
    // One cap pixel beside the kept edge in the same sweep.
    const collected = collectEntitiesFromPixels(buffer, WINDOW, WINDOW, registry)
    expect(collected).toEqual([{ layer: EDGE_LAYER_NAME, entityKey: 'edge@b#0' }])
  })
})

describe('section material flags', () => {
  it('gives the visible edge shader the clipping chunks and the flag', () => {
    const material = buildEdgeMaterial()
    expect(material.clipping).toBe(true)
    expect(material.vertexShader).toContain('clipping_planes_pars_vertex')
    expect(material.vertexShader).toContain('clipping_planes_vertex')
    expect(material.fragmentShader).toContain('clipping_planes_pars_fragment')
    expect(material.fragmentShader).toContain('clipping_planes_fragment')
  })
})
