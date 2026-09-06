import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { FaceIdLayer, FACE_LAYER_NAME } from '../FaceIdLayer'
import { rgbToId } from '../idEncoding'

function makeRegistration() {
  // Two triangles, two faces. Triangle 0 -> face 0, triangle 1 -> face 1.
  const positions = new Float32Array([
    // tri 0 (face 0)
    0, 0, 0,  1, 0, 0,  0, 1, 0,
    // tri 1 (face 1)
    1, 1, 0,  2, 1, 0,  1, 2, 0,
  ])
  return {
    bodyKey: 'feat1/body1',
    positions,
    triangleToFace: new Uint32Array([0, 1]),
    faceQueries: ['face@feat1#0', 'face@feat1#1'],
  }
}

describe('FaceIdLayer', () => {
  let reg: IdRegistry
  let layer: FaceIdLayer
  beforeEach(() => {
    reg = new IdRegistry()
    layer = new FaceIdLayer(reg)
  })

  it('registers one mesh per body', () => {
    expect(layer.bodyCount()).toBe(0)
    layer.registerBody(makeRegistration())
    expect(layer.bodyCount()).toBe(1)
    expect(layer.scene.children.length).toBe(1)
  })

  it('allocates one id per distinct face query', () => {
    layer.registerBody(makeRegistration())
    expect(reg.size()).toBe(2)
    expect(reg.lookupKey(FACE_LAYER_NAME, 'face@feat1#0')).toBeDefined()
    expect(reg.lookupKey(FACE_LAYER_NAME, 'face@feat1#1')).toBeDefined()
  })

  it('perPrimitivePickKeys gives colliding queries distinct ids, both carrying the query', () => {
    // Regression lock for query-naming Stage 6 (da168e62790): once geom identity
    // was removed from face queries, sibling faces with no minted UUID share one
    // ancestral query. Without per-primitive pick keys they collapse onto a single
    // ID and clicking one face selects the whole group. With the keys the IDs are
    // distinct and each record still reports the (shared) query.
    layer.registerBody({
      bodyKey: 'feat1/body1',
      positions: new Float32Array([
        0, 0, 0,  1, 0, 0,  0, 1, 0,   // tri 0 (face 0)
        1, 1, 0,  2, 1, 0,  1, 2, 0,   // tri 1 (face 1)
      ]),
      triangleToFace: new Uint32Array([0, 1]),
      faceQueries: ['face@dup', 'face@dup'],
      perPrimitivePickKeys: true,
    })
    const mesh = layer.scene.children[0] as import('three').Mesh
    const colorAttr = mesh.geometry.getAttribute('color')
    const id0 = rgbToId(colorAttr.getX(0) * 255, colorAttr.getY(0) * 255, colorAttr.getZ(0) * 255)
    const id1 = rgbToId(colorAttr.getX(3) * 255, colorAttr.getY(3) * 255, colorAttr.getZ(3) * 255)
    expect(id0).not.toBe(id1)
    expect(reg.lookup(id0)!.entityKey).toBe('face@dup')
    expect(reg.lookup(id1)!.entityKey).toBe('face@dup')
  })

  it('encodes per-triangle face color as the packed id RGB', () => {
    layer.registerBody(makeRegistration())
    const mesh = layer.scene.children[0] as import('three').Mesh
    const colorAttr = mesh.geometry.getAttribute('color')
    // Tri 0: all 3 vertices carry the id of face@feat1#0
    const id0 = reg.lookupKey(FACE_LAYER_NAME, 'face@feat1#0')!
    const id1 = reg.lookupKey(FACE_LAYER_NAME, 'face@feat1#1')!
    for (let v = 0; v < 3; v++) {
      const r = Math.round(colorAttr.getX(v) * 255)
      const g = Math.round(colorAttr.getY(v) * 255)
      const b = Math.round(colorAttr.getZ(v) * 255)
      expect(rgbToId(r, g, b)).toBe(id0)
    }
    for (let v = 3; v < 6; v++) {
      const r = Math.round(colorAttr.getX(v) * 255)
      const g = Math.round(colorAttr.getY(v) * 255)
      const b = Math.round(colorAttr.getZ(v) * 255)
      expect(rgbToId(r, g, b)).toBe(id1)
    }
  })

  it('unregister removes the mesh and frees its ids next cycle', () => {
    layer.registerBody(makeRegistration())
    expect(reg.size()).toBe(2)
    layer.unregisterBody('feat1/body1')
    expect(layer.bodyCount()).toBe(0)
    expect(layer.scene.children.length).toBe(0)
    expect(reg.size()).toBe(0)
  })

  it('re-registering with same key replaces the mesh', () => {
    layer.registerBody(makeRegistration())
    const firstMesh = layer.scene.children[0]
    layer.registerBody(makeRegistration())
    expect(layer.bodyCount()).toBe(1)
    expect(layer.scene.children[0]).not.toBe(firstMesh)
  })

  it('dispose clears every body and the material', () => {
    layer.registerBody(makeRegistration())
    layer.dispose()
    expect(layer.bodyCount()).toBe(0)
    expect(reg.size()).toBe(0)
  })

  it('rejects non-multiple-of-9 position arrays', () => {
    expect(() => layer.registerBody({
      bodyKey: 'bad',
      positions: new Float32Array(10),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['q'],
    })).toThrow()
  })

  it('skips triangles whose face index has no query', () => {
    // One triangle pointing at face 5, but only 2 queries -> the triangle's
    // face has no stable key, so no id is allocated for it.
    layer.registerBody({
      bodyKey: 'sparse',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([5]),
      faceQueries: ['q0', 'q1'],
    })
    expect(reg.size()).toBe(0)
  })

  // ─── Fail-loud validation (stale-pick hardening) ───

  it('throws on a triangleToFace shorter than the triangle count and touches nothing', () => {
    // The former `triangleToFace[tri] ?? 0` fallback recolored the unmapped
    // triangles with face 0's id, so picking them selected the wrong face.
    expect(() => layer.registerBody({
      bodyKey: 'bad',
      positions: new Float32Array(18),  // 2 triangles
      triangleToFace: new Uint32Array([0]),  // one entry short
      faceQueries: ['q0', 'q1'],
    })).toThrow(/triangleToFace/)
    expect(layer.scene.children.length).toBe(0)
    expect(reg.size()).toBe(0)
  })

  it('keeps an existing registration intact when a replacement fails validation', () => {
    layer.registerBody(makeRegistration())
    const before = layer.scene.children[0]
    expect(() => layer.registerBody({
      bodyKey: 'feat1/body1',
      positions: new Float32Array(18),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['face@feat1#0', 'face@feat1#1'],
    })).toThrow()
    // Validation runs BEFORE the unregister pre-clear, so the good geometry
    // survives a bad re-register instead of vanishing with its ids freed.
    expect(layer.scene.children[0]).toBe(before)
    expect(reg.size()).toBe(2)
  })

  it('excludes an unnamed triangle from the drawn geometry so it cannot occlude', () => {
    // jsdom has no GPU pass (see facePickParity.test.ts), so "no visible
    // pixels" is pinned structurally: the unnamed triangle must not be part
    // of the rasterised position buffer at all. Drawn black it decoded to
    // EMPTY_ID while still writing depth, occluding whatever lay behind it --
    // including at the buffer centre where both triangles overlap here.
    const valid = [0, 0, 5, 10, 0, 5, 5, 10, 5]           // tri over the centre
    const unnamed = [2, 2, 5, 8, 2, 5, 5, 6, 5]           // overlapping tri, face has no query
    layer.registerBody({
      bodyKey: 'mixed',
      positions: new Float32Array([...valid, ...unnamed]),
      triangleToFace: new Uint32Array([0, 7]),  // face 7 is out of query range
      faceQueries: ['face@q0'],
    })
    const mesh = layer.scene.children[0] as import('three').Mesh
    const posAttr = mesh.geometry.getAttribute('position')
    expect(posAttr.count).toBe(3)  // only the named triangle remains
    for (let i = 0; i < 9; i++) expect(posAttr.array[i]).toBe(valid[i])
    // The face behind still decodes through the registry.
    const colorAttr = mesh.geometry.getAttribute('color')
    const id = rgbToId(
      Math.round(colorAttr.getX(0) * 255),
      Math.round(colorAttr.getY(0) * 255),
      Math.round(colorAttr.getZ(0) * 255),
    )
    expect(reg.lookup(id)!.entityKey).toBe('face@q0')
  })

  it('excludes triangles with non-finite positions so they cannot occlude', () => {
    // Collapsed tessellation output: unnameable AND unrasterisable garbage.
    layer.registerBody({
      bodyKey: 'nan-tri',
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        NaN, 0, 0, 1, 0, 0, 0, 1, 0,
      ]),
      triangleToFace: new Uint32Array([0, 0]),
      faceQueries: ['face@q0'],
    })
    const mesh = layer.scene.children[0] as import('three').Mesh
    expect((mesh.geometry.getAttribute('position')).count).toBe(3)
    expect(reg.size()).toBe(1)
  })

  it('a fully-filtered body adds nothing to the scene (g4-L3)', () => {
    // Every triangle points at an out-of-range face, so drawn === 0. The old
    // code still created an empty mesh and added it, defeating the pipeline's
    // scene.children.length === 0 empty-layer skip.
    layer.registerBody({
      bodyKey: 'all-unnamed',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 1, 2, 0]),
      triangleToFace: new Uint32Array([5, 6]),
      faceQueries: ['q0'],
    })
    expect(layer.bodyCount()).toBe(0)
    expect(layer.scene.children.length).toBe(0)
    expect(reg.size()).toBe(0)
  })

  it('a fully-filtered re-register still clears the prior body (g4-L3)', () => {
    layer.registerBody(makeRegistration())
    expect(layer.bodyCount()).toBe(1)
    layer.registerBody({
      bodyKey: 'feat1/body1',
      positions: new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['face@feat1#0'],
    })
    // Pre-clear ran before the drawn === 0 exit: the good geometry is gone.
    expect(layer.bodyCount()).toBe(0)
    expect(layer.scene.children.length).toBe(0)
  })

  it('frees ids allocated before a mid-loop allocation failure', () => {
    const realAllocate = reg.allocate.bind(reg)
    let calls = 0
    const spy = vi.spyOn(reg, 'allocate').mockImplementation((layer, entityKey, pickKey) => {
      if (++calls > 1) throw new Error('IdRegistry: exhausted 24-bit ID space')
      return realAllocate(layer, entityKey, pickKey)
    })
    expect(() => layer.registerBody(makeRegistration())).toThrow(/exhausted/)
    // Nothing leaked: the first id was freed back, and nothing is registered.
    expect(reg.size()).toBe(0)
    expect(layer.scene.children.length).toBe(0)
    spy.mockRestore()
  })
})
