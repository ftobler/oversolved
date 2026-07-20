import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { IdRegistry } from '../IdRegistry'
import { VertexIdLayer } from '../VertexIdLayer'
import { IdPipeline, VERTEX_PICK_CUBE_PIXELS } from '../IdPipeline'
import { CUBE_CORNER_SIGNS, CUBE_TRIANGLE_INDICES, pixelCubeHalfExtent } from '../screenSpaceScale'

const VERTICES: [number, number, number][] = [[0, 0, 0], [5, 0, 0], [0, 5, 0]]
const QUERIES = ['vtx@A', 'vtx@B', 'vtx@C']

function cubeLayer(reg: IdRegistry) {
  const layer = new VertexIdLayer(reg, { cubePixels: VERTEX_PICK_CUBE_PIXELS })
  layer.registerBody({ bodyKey: 'b', vertices: VERTICES, vertexQueries: QUERIES, perPrimitivePickKeys: true })
  return layer
}

describe('vertex pick cubes', () => {
  it('the B-rep vertex layer draws 3px cubes in both part and assembly viewports', () => {
    // Part (useVertexIdRegistration) and assembly (AssemblyPickLayers) both
    // register into this one layer, so a single assertion covers both views.
    const p = new IdPipeline({ width: 100, height: 100 })
    expect(p.vertexLayer.getCubePixels()).toBe(VERTEX_PICK_CUBE_PIXELS)
    expect(VERTEX_PICK_CUBE_PIXELS).toBe(3)
    p.dispose()
  })

  it('cube mode drops the always-win depth hack and depth-tests normally', () => {
    const layer = cubeLayer(new IdRegistry())
    const mat = (layer.scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial
    expect(mat.depthTest).toBe(true)
    // depthWrite stays off so the cubes do not carve holes in the face depth
    // that the sketch surface layer later tests against.
    expect(mat.depthWrite).toBe(false)
    expect(mat.side).toBe(THREE.DoubleSide)
    layer.dispose()
  })

  it('emits a Mesh of 8 corners and 12 triangles per vertex', () => {
    const layer = cubeLayer(new IdRegistry())
    const mesh = layer.scene.children[0] as THREE.Mesh
    expect(mesh).toBeInstanceOf(THREE.Mesh)
    const geo = mesh.geometry
    expect(geo.getAttribute('position').count).toBe(VERTICES.length * 8)
    expect(geo.getIndex()!.count).toBe(VERTICES.length * CUBE_TRIANGLE_INDICES.length)
    layer.dispose()
  })

  it('all 8 corners of a vertex share that vertex position and ID color', () => {
    const layer = cubeLayer(new IdRegistry())
    const geo = (layer.scene.children[0] as THREE.Mesh).geometry
    const pos = geo.getAttribute('position')
    const col = geo.getAttribute('aColor')
    for (let v = 0; v < VERTICES.length; v++) {
      for (let c = 0; c < 8; c++) {
        const i = v * 8 + c
        expect([pos.getX(i), pos.getY(i), pos.getZ(i)]).toEqual(VERTICES[v])
        expect(col.getX(i)).toBe(col.getX(v * 8))
        expect(col.getY(i)).toBe(col.getY(v * 8))
        expect(col.getZ(i)).toBe(col.getZ(v * 8))
      }
    }
    layer.dispose()
  })

  it('aCorner carries the eight sign combinations, giving the cube depth extent', () => {
    const layer = cubeLayer(new IdRegistry())
    const geo = (layer.scene.children[0] as THREE.Mesh).geometry
    const corner = geo.getAttribute('aCorner')
    for (let v = 0; v < VERTICES.length; v++) {
      const seen = new Set<string>()
      let zSpread = 0
      for (let c = 0; c < 8; c++) {
        const i = v * 8 + c
        seen.add([corner.getX(i), corner.getY(i), corner.getZ(i)].join(','))
        zSpread = Math.max(zSpread, Math.abs(corner.getZ(i)))
      }
      expect(seen.size).toBe(8)
      // A flat billboard would leave aCorner.z at 0; the depth extent is the
      // whole point of the change.
      expect(zSpread).toBe(1)
    }
    expect(corner.count).toBe(VERTICES.length * CUBE_CORNER_SIGNS.length)
    layer.dispose()
  })

  it('triangle indices stay within each vertex own 8-corner block', () => {
    const layer = cubeLayer(new IdRegistry())
    const idx = (layer.scene.children[0] as THREE.Mesh).geometry.getIndex()!
    for (let t = 0; t < idx.count; t += 3) {
      const block = Math.floor(idx.getX(t) / 8)
      for (let k = 0; k < 3; k++) expect(Math.floor(idx.getX(t + k) / 8)).toBe(block)
    }
    layer.dispose()
  })

  it('uses a 32-bit index buffer so bodies past 8k vertices do not wrap', () => {
    const idx = (cubeLayer(new IdRegistry()).scene.children[0] as THREE.Mesh).geometry.getIndex()!
    expect(idx.array).toBeInstanceOf(Uint32Array)
  })

  it('onBeforeRender feeds the viewport height the shader needs for pixel sizing', () => {
    const layer = cubeLayer(new IdRegistry())
    const mat = (layer.scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial
    layer.onBeforeRender(1024, 768)
    expect(mat.uniforms.uViewportHeight.value).toBe(768)
    expect(mat.uniforms.uHalfPixels.value).toBe(VERTEX_PICK_CUBE_PIXELS / 2)
    layer.dispose()
  })

  it('half extent from the shared formula is 1.5px, enough to clear the face it sits on', () => {
    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300)
    cam.zoom = 8
    cam.updateProjectionMatrix()
    const half = pixelCubeHalfExtent(VERTEX_PICK_CUBE_PIXELS, cam.projectionMatrix.elements[5], 600, 1)
    expect(half).toBeGreaterThan(0)
    expect(half / (1 / cam.zoom)).toBeCloseTo(1.5, 8)
  })

  it('skips vertices without a query in cube mode too', () => {
    const reg = new IdRegistry()
    const layer = new VertexIdLayer(reg, { cubePixels: 3 })
    layer.registerBody({ bodyKey: 'partial', vertices: [[0, 0, 0], [1, 0, 0]], vertexQueries: ['vtx@only'] })
    expect(reg.size()).toBe(1)
    expect((layer.scene.children[0] as THREE.Mesh).geometry.getAttribute('position').count).toBe(8)
    layer.dispose()
  })

  it('helper vertex layers are untouched: still 1px depth-less points', () => {
    // Sketch vertices, the origin marker and dimension labels are gizmo
    // overlays that must keep winning unconditionally.
    const p = new IdPipeline({ width: 100, height: 100 })
    for (const layer of [p.sketchVertexLayer, p.originLayer, p.dimensionLabelLayer]) {
      expect(layer.getCubePixels()).toBeUndefined()
      expect(layer.zPolicy).toBe('no-depth')
      layer.registerBody({ bodyKey: 'h', vertices: VERTICES, vertexQueries: QUERIES })
      const obj = layer.scene.children[0]
      expect(obj).toBeInstanceOf(THREE.Points)
      expect(((obj as THREE.Points).material as THREE.ShaderMaterial).depthTest).toBe(false)
    }
    p.dispose()
  })
})
