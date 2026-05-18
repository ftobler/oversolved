import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { VertexIdLayer, VERTEX_LAYER_NAME } from '../VertexIdLayer'
import { rgbToId } from '../idEncoding'

function makeReg() {
  const vertices: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ]
  const vertexQueries = ['vtx@A', 'vtx@B', 'vtx@C']
  return { bodyKey: 'b', vertices, vertexQueries }
}

describe('VertexIdLayer', () => {
  let reg: IdRegistry
  let layer: VertexIdLayer
  beforeEach(() => {
    reg = new IdRegistry()
    layer = new VertexIdLayer(reg)
  })

  it('registers one Points per body', () => {
    layer.registerBody(makeReg())
    expect(layer.bodyCount()).toBe(1)
    expect(layer.scene.children.length).toBe(1)
    const pts = layer.scene.children[0] as import('three').Points
    expect(pts.geometry.getAttribute('position').count).toBe(3)
  })

  it('allocates one id per vertex query', () => {
    layer.registerBody(makeReg())
    expect(reg.size()).toBe(3)
    for (const q of ['vtx@A', 'vtx@B', 'vtx@C']) {
      expect(reg.lookupKey(VERTEX_LAYER_NAME, q)).toBeDefined()
    }
  })

  it('aColor per vertex decodes to the vertex id', () => {
    layer.registerBody(makeReg())
    const pts = layer.scene.children[0] as import('three').Points
    const aColor = pts.geometry.getAttribute('aColor')
    for (let i = 0; i < 3; i++) {
      const r = Math.round(aColor.getX(i) * 255)
      const g = Math.round(aColor.getY(i) * 255)
      const b = Math.round(aColor.getZ(i) * 255)
      const id = rgbToId(r, g, b)
      const rec = reg.lookup(id)
      expect(rec).toBeDefined()
      expect(rec!.layer).toBe(VERTEX_LAYER_NAME)
    }
  })

  it('position attribute holds the world-space vertex positions', () => {
    layer.registerBody(makeReg())
    const pts = layer.scene.children[0] as import('three').Points
    const pos = pts.geometry.getAttribute('position')
    const expected = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
    for (let i = 0; i < 3; i++) {
      expect([pos.getX(i), pos.getY(i), pos.getZ(i)]).toEqual(expected[i])
    }
  })

  it('material runs with depthTest=false (vertices always win where drawn)', () => {
    layer.registerBody(makeReg())
    const pts = layer.scene.children[0] as import('three').Points
    const mat = pts.material as import('three').ShaderMaterial
    expect(mat.depthTest).toBe(false)
  })

  it('skips vertices whose query is missing', () => {
    layer.registerBody({
      bodyKey: 'partial',
      vertices: [[0, 0, 0], [1, 0, 0]],
      vertexQueries: ['vtx@only'],  // length 1, vertex[1] has no query
    })
    expect(reg.size()).toBe(1)
    const pts = layer.scene.children[0] as import('three').Points
    expect(pts.geometry.getAttribute('position').count).toBe(1)
  })

  it('unregister removes Points and frees ids', () => {
    layer.registerBody(makeReg())
    layer.unregisterBody('b')
    expect(layer.bodyCount()).toBe(0)
    expect(reg.size()).toBe(0)
  })

  it('dispose clears every body and the material', () => {
    layer.registerBody(makeReg())
    layer.dispose()
    expect(layer.bodyCount()).toBe(0)
  })
})
