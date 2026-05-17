import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { EdgeIdLayer, EDGE_LAYER_NAME, EDGE_FAT_PIXELS } from '../EdgeIdLayer'
import { rgbToId } from '../idEncoding'

function makeReg() {
  // 3 segments belonging to 2 edges. Edge 0 has segments 0,1. Edge 1 has segment 2.
  const segmentPositions = new Float32Array([
    0, 0, 0,  1, 0, 0,    // seg 0 (edge 0)
    1, 0, 0,  2, 0, 0,    // seg 1 (edge 0)
    0, 1, 0,  0, 2, 0,    // seg 2 (edge 1)
  ])
  const segmentToEdge = new Uint32Array([0, 0, 1])
  const edgeQueries = ['edge@A', 'edge@B']
  return { bodyKey: 'b', segmentPositions, segmentToEdge, edgeQueries }
}

describe('EdgeIdLayer', () => {
  let reg: IdRegistry
  let layer: EdgeIdLayer
  beforeEach(() => {
    reg = new IdRegistry()
    layer = new EdgeIdLayer(reg)
  })

  it('registers one mesh per body', () => {
    layer.registerBody(makeReg())
    expect(layer.bodyCount()).toBe(1)
    expect(layer.scene.children.length).toBe(1)
  })

  it('allocates one id per distinct edge query', () => {
    layer.registerBody(makeReg())
    expect(reg.size()).toBe(2)
    expect(reg.lookupKey(EDGE_LAYER_NAME, 'edge@A')).toBeDefined()
    expect(reg.lookupKey(EDGE_LAYER_NAME, 'edge@B')).toBeDefined()
  })

  it('each segment expands to 6 ribbon vertices', () => {
    layer.registerBody(makeReg())
    const mesh = layer.scene.children[0] as import('three').Mesh
    const positionAttr = mesh.geometry.getAttribute('position')
    // 3 segments * 6 vertices each = 18 vertices.
    expect(positionAttr.count).toBe(18)
  })

  it('all 6 ribbon vertices of a segment carry the same edge id color', () => {
    layer.registerBody(makeReg())
    const mesh = layer.scene.children[0] as import('three').Mesh
    const colorAttr = mesh.geometry.getAttribute('aColor')
    const idEdgeA = reg.lookupKey(EDGE_LAYER_NAME, 'edge@A')!
    const idEdgeB = reg.lookupKey(EDGE_LAYER_NAME, 'edge@B')!
    // Segments 0 and 1 -> edge A. Segment 2 -> edge B.
    for (let seg = 0; seg < 3; seg++) {
      const expectedId = seg < 2 ? idEdgeA : idEdgeB
      for (let v = 0; v < 6; v++) {
        const vi = seg * 6 + v
        const r = Math.round(colorAttr.getX(vi) * 255)
        const g = Math.round(colorAttr.getY(vi) * 255)
        const b = Math.round(colorAttr.getZ(vi) * 255)
        expect(rgbToId(r, g, b)).toBe(expectedId)
      }
    }
  })

  it('aSide alternates -1 / +1 across the 6 ribbon vertices', () => {
    layer.registerBody(makeReg())
    const mesh = layer.scene.children[0] as import('three').Mesh
    const sideAttr = mesh.geometry.getAttribute('aSide')
    // Pattern per segment: -1, +1, -1, +1, +1, -1
    const expected = [-1, +1, -1, +1, +1, -1]
    for (let seg = 0; seg < 3; seg++) {
      for (let v = 0; v < 6; v++) {
        expect(sideAttr.getX(seg * 6 + v)).toBe(expected[v])
      }
    }
  })

  it('aOther on a ribbon vertex is the OTHER endpoint of its segment', () => {
    layer.registerBody(makeReg())
    const mesh = layer.scene.children[0] as import('three').Mesh
    const positionAttr = mesh.geometry.getAttribute('position')
    const otherAttr = mesh.geometry.getAttribute('aOther')
    // Pick segment 0 (s=(0,0,0), e=(1,0,0)).
    // Vertices 0,1,3 sit at s and must have other = e.
    // Vertices 2,4,5 sit at e and must have other = s.
    const atS = [0, 1, 3]
    const atE = [2, 4, 5]
    for (const i of atS) {
      expect([positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i)])
        .toEqual([0, 0, 0])
      expect([otherAttr.getX(i), otherAttr.getY(i), otherAttr.getZ(i)])
        .toEqual([1, 0, 0])
    }
    for (const i of atE) {
      expect([positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i)])
        .toEqual([1, 0, 0])
      expect([otherAttr.getX(i), otherAttr.getY(i), otherAttr.getZ(i)])
        .toEqual([0, 0, 0])
    }
  })

  it('onBeforeRender updates the uViewport uniform; ribbon width stays isotropic in pixels', () => {
    layer.registerBody(makeReg())
    layer.onBeforeRender!(1920, 1080)
    const mesh = layer.scene.children[0] as import('three').Mesh
    const mat = mesh.material as import('three').ShaderMaterial
    const v = mat.uniforms.uViewport.value as import('three').Vector2
    expect(v.x).toBe(1920)
    expect(v.y).toBe(1080)
    expect(mat.uniforms.uFatPixels.value).toBe(EDGE_FAT_PIXELS)
  })

  it('setXrayEdges swaps to a depthTest:false material on every registered body', () => {
    layer.registerBody(makeReg())
    const mesh = layer.scene.children[0] as import('three').Mesh
    const baseMat = mesh.material as import('three').ShaderMaterial
    expect(baseMat.depthTest).toBe(true)
    layer.setXrayEdges(true)
    const xrayMat = mesh.material as import('three').ShaderMaterial
    expect(xrayMat.depthTest).toBe(false)
    expect(layer.isXrayEdges()).toBe(true)
    layer.setXrayEdges(false)
    expect((mesh.material as import('three').ShaderMaterial).depthTest).toBe(true)
  })

  it('unregister removes the mesh and frees its ids next cycle', () => {
    layer.registerBody(makeReg())
    layer.unregisterBody('b')
    expect(layer.bodyCount()).toBe(0)
    expect(layer.scene.children.length).toBe(0)
    // size() reflects byKey, which drops immediately on free.
    expect(reg.size()).toBe(0)
  })

  it('rejects malformed segment buffers', () => {
    expect(() => layer.registerBody({
      bodyKey: 'bad',
      segmentPositions: new Float32Array(5),  // not a multiple of 6
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['e'],
    })).toThrow()
  })

  it('dispose clears every body and the materials', () => {
    layer.registerBody(makeReg())
    layer.dispose()
    expect(layer.bodyCount()).toBe(0)
    expect(reg.size()).toBe(0)
  })
})
