import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { EdgeIdLayer, EDGE_LAYER_NAME } from '../EdgeIdLayer'
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

  it('registers one LineSegments per body', () => {
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

  it('each segment produces 2 vertices', () => {
    layer.registerBody(makeReg())
    const seg = layer.scene.children[0] as import('three').LineSegments
    const positionAttr = seg.geometry.getAttribute('position')
    // 3 segments * 2 vertices each = 6 vertices.
    expect(positionAttr.count).toBe(6)
  })

  it('both vertices of a segment carry the same edge id color', () => {
    layer.registerBody(makeReg())
    const seg = layer.scene.children[0] as import('three').LineSegments
    const colorAttr = seg.geometry.getAttribute('aColor')
    const idEdgeA = reg.lookupKey(EDGE_LAYER_NAME, 'edge@A')!
    const idEdgeB = reg.lookupKey(EDGE_LAYER_NAME, 'edge@B')!
    // Segments 0 and 1 -> edge A. Segment 2 -> edge B.
    for (let segIdx = 0; segIdx < 3; segIdx++) {
      const expectedId = segIdx < 2 ? idEdgeA : idEdgeB
      for (let v = 0; v < 2; v++) {
        const vi = segIdx * 2 + v
        const r = Math.round(colorAttr.getX(vi) * 255)
        const g = Math.round(colorAttr.getY(vi) * 255)
        const b = Math.round(colorAttr.getZ(vi) * 255)
        expect(rgbToId(r, g, b)).toBe(expectedId)
      }
    }
  })

  it('setXrayEdges swaps to a depthTest:false material on every registered body', () => {
    layer.registerBody(makeReg())
    const seg = layer.scene.children[0] as import('three').LineSegments
    const baseMat = seg.material as import('three').ShaderMaterial
    expect(baseMat.depthTest).toBe(true)
    layer.setXrayEdges(true)
    const xrayMat = seg.material as import('three').ShaderMaterial
    expect(xrayMat.depthTest).toBe(false)
    expect(layer.isXrayEdges()).toBe(true)
    layer.setXrayEdges(false)
    expect((seg.material as import('three').ShaderMaterial).depthTest).toBe(true)
  })

  it('unregister removes the LineSegments and frees its ids next cycle', () => {
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

  // ─── Ghost mode transition tests ───

  it('replaces edge registration on same bodyKey (simulates React in-place update across ternary branches)', () => {
    // Ghost mode: register pickBodies edges
    layer.registerBody({
      bodyKey: 'body_ex1',
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['?old_pick_edge:edge'],
    })
    expect(layer.bodyCount()).toBe(1)
    const oldId = reg.lookupKey(EDGE_LAYER_NAME, '?old_pick_edge:edge')
    expect(oldId).toBeDefined()

    // React updates Body3D in place: cleanup unregisters, setup re-registers
    layer.unregisterBody('body_ex1')
    layer.registerBody({
      bodyKey: 'body_ex1',
      segmentPositions: new Float32Array([0, 0, 0, 1, 1, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['?new_fillet_edge:edge'],
    })

    expect(layer.bodyCount()).toBe(1)
    // Old edge query must be gone from the registry
    expect(reg.lookupKey(EDGE_LAYER_NAME, '?old_pick_edge:edge')).toBeUndefined()
    // New edge query must be registered
    const newId = reg.lookupKey(EDGE_LAYER_NAME, '?new_fillet_edge:edge')
    expect(newId).toBeDefined()
    // Must be a different ID (old was freed, new allocated)
    expect(newId).not.toBe(oldId)
  })

  it('replaces edge registration on different bodyKey (simulates React unmount/remount across ternary branches)', () => {
    // Ghost mode: pickBodies uses bodyKey 'extrude1/body_ex1'
    layer.registerBody({
      bodyKey: 'extrude1/body_ex1',
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['?pick_edge:edge'],
    })
    expect(layer.bodyCount()).toBe(1)

    // Accept: pickBodyItems Body3D unmounts
    layer.unregisterBody('extrude1/body_ex1')
    expect(layer.bodyCount()).toBe(0)

    // bodyItems Body3D mounts with different bodyKey
    layer.registerBody({
      bodyKey: 'fillet1/body_ex1',
      segmentPositions: new Float32Array([0, 0, 0, 1, 1, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['?fillet_edge:edge'],
    })

    expect(layer.bodyCount()).toBe(1)
    // Old pick edge must be freed
    expect(reg.lookupKey(EDGE_LAYER_NAME, '?pick_edge:edge')).toBeUndefined()
    // New fillet edge must be registered
    expect(reg.lookupKey(EDGE_LAYER_NAME, '?fillet_edge:edge')).toBeDefined()
  })

  it('registerBody internally unregisters before registering (defense against missing cleanup)', () => {
    // Even if the old cleanup effect fails to run, registerBody's own
    // unregisterBody handles the replacement.
    layer.registerBody({
      bodyKey: 'body_ex1',
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['?old_edge:edge'],
    })
    expect(layer.bodyCount()).toBe(1)

    // Call registerBody directly with the same bodyKey (no explicit unregister)
    layer.registerBody({
      bodyKey: 'body_ex1',
      segmentPositions: new Float32Array([0, 0, 0, 1, 1, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['?new_edge:edge'],
    })

    // The old registration must be replaced, not duplicated
    expect(layer.bodyCount()).toBe(1)
    expect(reg.lookupKey(EDGE_LAYER_NAME, '?old_edge:edge')).toBeUndefined()
    expect(reg.lookupKey(EDGE_LAYER_NAME, '?new_edge:edge')).toBeDefined()
    // Scene must have exactly 1 mesh (not 2)
    expect(layer.scene.children.length).toBe(1)
  })
})
