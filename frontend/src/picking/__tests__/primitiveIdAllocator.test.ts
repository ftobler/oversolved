import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { PrimitiveIdAllocator } from '../IdLayer'
import { FaceIdLayer } from '../FaceIdLayer'
import { EdgeIdLayer } from '../EdgeIdLayer'
import { VertexIdLayer } from '../VertexIdLayer'
import { idToRGBNormalized } from '../idEncoding'
import { primitivePickKey } from '../pickKey'

/**
 * The face, edge and vertex layers all earn their IDs through one
 * `PrimitiveIdAllocator`. This file owns that shared half: the pick-key choice,
 * the per-index color memo, the once-per-ID free list, and the duplicate-query
 * diagnostic -- which had no coverage at all while it was three copies.
 *
 * `_warnedDuplicates` in IdLayer.ts is module-level and deliberately never
 * cleared (once per session per (layer, query)), so every test that expects a
 * warning uses its OWN layer name. Reusing one would make the second such test
 * pass or fail depending on file order.
 */

const BODY = 'feat1/body1'

function makeAllocator(reg: IdRegistry, opts?: {
  perPrimitive?: boolean
  layerName?: string
  bodyKey?: string
}): PrimitiveIdAllocator {
  return new PrimitiveIdAllocator(
    reg,
    opts?.layerName ?? 'testLayer',
    'widgets',
    opts?.bodyKey ?? BODY,
    opts?.perPrimitive ?? true,
  )
}

describe('PrimitiveIdAllocator, per-primitive keying (b-rep)', () => {
  let reg: IdRegistry
  beforeEach(() => { reg = new IdRegistry() })

  it('keys each ID on the primitive index, so colliding queries stay distinct', () => {
    const ids = makeAllocator(reg)
    const rgb0 = ids.rgbFor(0, 'face@dup')
    const rgb1 = ids.rgbFor(1, 'face@dup')

    expect(rgb0).not.toEqual(rgb1)
    const [id0, id1] = ids.allocatedIds
    expect(id0).not.toBe(id1)
    // Both records still report the shared query as their semantic identity.
    expect(reg.lookup(id0)!.entityKey).toBe('face@dup')
    expect(reg.lookup(id1)!.entityKey).toBe('face@dup')
    // ...and the layer-qualified primitive key as their uniqueness key, which is
    // what Body3D recomputes to isolate the one primitive under the cursor.
    expect(reg.lookup(id0)!.pickKey).toBe(primitivePickKey(BODY, 0, 'testLayer'))
    expect(reg.lookup(id1)!.pickKey).toBe(primitivePickKey(BODY, 1, 'testLayer'))
  })

  it('lists allocatedIds in ask order', () => {
    // Recycle two IDs first so ask order and numeric order DIVERGE: the free list
    // pops from its end, so the first ask takes the HIGHER id. Without this the
    // asks take ids 1 then 2 and a sorted list would pass just as well.
    reg.free(reg.allocate('testLayer', 'throwaway1'))
    reg.free(reg.allocate('testLayer', 'throwaway2'))
    reg.bumpCycle()

    const ids = makeAllocator(reg)
    ids.rgbFor(7, 'q7')
    ids.rgbFor(2, 'q2')
    const [first, second] = ids.allocatedIds
    expect(first).toBeGreaterThan(second)
    expect(reg.lookup(first)!.entityKey).toBe('q7')
    expect(reg.lookup(second)!.entityKey).toBe('q2')
  })

  it('returns exactly the packed RGB of the allocated ID', () => {
    const ids = makeAllocator(reg)
    const rgb = ids.rgbFor(3, 'q3')
    const id = reg.lookupKey('testLayer', primitivePickKey(BODY, 3, 'testLayer'))!
    expect(rgb).toEqual(idToRGBNormalized(id))
  })

  it('memoizes per index: a re-ask allocates nothing and returns the same color', () => {
    const ids = makeAllocator(reg)
    const spy = vi.spyOn(reg, 'allocate')
    const first = ids.rgbFor(4, 'q4')
    const again = ids.rgbFor(4, 'q4')
    // The memo is what makes "one ask per triangle / per segment" cheap: the
    // registry must be consulted once per primitive, not once per vertex written.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(again).toBe(first)
    expect(ids.allocatedIds).toHaveLength(1)
    spy.mockRestore()
  })

  it('the memo answers on the index alone, ignoring a changed query', () => {
    // Pins the contract now that the memo is shared code: the index IS the
    // primitive, so a caller passing a different query for one it already asked
    // about gets the first answer back, not a second registration.
    const ids = makeAllocator(reg)
    const first = ids.rgbFor(5, 'q5')
    expect(ids.rgbFor(5, 'a-different-query')).toBe(first)
    expect(ids.allocatedIds).toHaveLength(1)
    expect(reg.lookup(ids.allocatedIds[0])!.entityKey).toBe('q5')
  })

  // Locks the outcome, not the guard: the diagnostic probes the registry by
  // query while this mode registers by pickKey, so it stays silent even with the
  // `!perPrimitive` guard removed. Two b-rep faces sharing a query is normal.
  it('never warns, however badly the queries collide', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ids = makeAllocator(reg, { layerName: 'perPrimNoWarn' })
    ids.rgbFor(0, 'same')
    ids.rgbFor(1, 'same')
    ids.rgbFor(2, 'same')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('PrimitiveIdAllocator, query keying (layer reusers)', () => {
  let reg: IdRegistry
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    reg = new IdRegistry()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { warn.mockRestore() })

  it('allocates under the query itself', () => {
    const ids = makeAllocator(reg, { perPrimitive: false })
    ids.rgbFor(0, 'entity:S1:lineA')
    const id = reg.lookupKey('testLayer', 'entity:S1:lineA')!
    expect(id).toBeDefined()
    expect(reg.lookup(id)!.pickKey).toBe('entity:S1:lineA')
  })

  it('collapses two primitives sharing a query onto one ID, listed once', () => {
    // The collapse itself is the documented cost of query keying. What must not
    // happen is the ID being listed twice: unregisterBody frees every entry, so a
    // repeat would make one body hand the registry the same ID twice.
    const ids = makeAllocator(reg, { perPrimitive: false, layerName: 'collapseOnce' })
    const rgb0 = ids.rgbFor(0, 'dup')
    const rgb1 = ids.rgbFor(1, 'dup')
    expect(rgb1).toEqual(rgb0)
    expect(ids.allocatedIds).toHaveLength(1)
  })

  it('warns once when a later primitive of the body repeats a query', () => {
    const ids = makeAllocator(reg, { perPrimitive: false, layerName: 'warnsOnce' })
    ids.rgbFor(0, 'first')
    ids.rgbFor(1, 'dup')
    ids.rgbFor(2, 'dup')  // memo miss (new index), same query -> collision again
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = warn.mock.calls[0][0] as string
    expect(msg).toContain('[warnsOnce]')     // the layer INSTANCE, not the class
    expect(msg).toContain('Two widgets')     // the layer's primitive noun
    expect(msg).toContain(BODY)
    expect(msg).toContain('query="dup"')
  })

  it('stays quiet when a query is distinct within the body', () => {
    const ids = makeAllocator(reg, { perPrimitive: false, layerName: 'quietDistinct' })
    ids.rgbFor(0, 'a')
    ids.rgbFor(1, 'b')
    ids.rgbFor(2, 'c')
    expect(warn).not.toHaveBeenCalled()
  })

  it('stays quiet when the first primitive of a body matches another body\'s query', () => {
    // Two bodies of one layer legitimately share a query (see selectionHighlight):
    // the "at least one earlier allocation in THIS body" guard is what keeps that
    // case from crying wolf on every registration.
    const first = makeAllocator(reg, { perPrimitive: false, layerName: 'quietCrossBody', bodyKey: 'b1' })
    first.rgbFor(0, 'shared')
    const second = makeAllocator(reg, { perPrimitive: false, layerName: 'quietCrossBody', bodyKey: 'b2' })
    second.rgbFor(0, 'shared')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('id layers share one allocator', () => {
  let reg: IdRegistry
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    reg = new IdRegistry()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { warn.mockRestore() })

  // Two triangles, face 0 and face 1, sharing whatever queries are passed.
  function registerTwoFaces(layer: FaceIdLayer, faceQueries: string[]): void {
    layer.registerBody({
      bodyKey: BODY,
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 1, 0, 2, 1, 0, 1, 2, 0,
      ]),
      triangleToFace: new Uint32Array([0, 1]),
      faceQueries,
    })
  }

  // One triangle, one face, under an explicit body key.
  function registerOneFace(layer: FaceIdLayer, bodyKey: string, query: string): void {
    layer.registerBody({
      bodyKey,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: [query],
    })
  }

  it('a shared ID reaches the free list once, so recycled IDs stay unique', () => {
    // Regression: two faces sharing a query collapsed onto one ID which was then
    // freed twice, landing twice on the recycle list -- after which two unrelated
    // entities were handed the SAME ID and cross-selected. The allocator's Set is
    // what fixes it here; the cross-body case below is the half it cannot see.
    const layer = new FaceIdLayer(reg, { name: 'doubleFree' })
    registerTwoFaces(layer, ['dup', 'dup'])
    expect(reg.size()).toBe(1)

    layer.unregisterBody(BODY)
    reg.bumpCycle()

    expect(reg.allocate('doubleFree', 'alpha')).not.toBe(reg.allocate('doubleFree', 'beta'))
  })

  it('frees a collapsed id when its single holding body unregisters', () => {
    // Two primitives of ONE body sharing a query collapse onto one id, so the
    // body holds it once and its teardown must release the record. Counting the
    // collapse as two holders left the id resolvable after its only holder left.
    const layer = new FaceIdLayer(reg, { name: 'collapseFree' })
    registerTwoFaces(layer, ['dup', 'dup'])
    const shared = reg.lookupKey('collapseFree', 'dup')!
    expect(reg.lookup(shared)).toBeDefined()

    layer.unregisterBody(BODY)
    reg.bumpCycle()

    expect(reg.lookup(shared)).toBeUndefined()
  })

  it('two BODIES sharing a query free their one shared ID once between them', () => {
    // The same collapse across bodies, which no per-body account can catch: each
    // body legitimately holds the id once, so `unregisterBody` frees it once per
    // body -- two calls, one id. Only `IdRegistry.pendingFree` being a Set keeps
    // it off `freeList` twice. This is the case that pins that half of the fix.
    const layer = new FaceIdLayer(reg, { name: 'crossBodyFree' })
    registerOneFace(layer, 'b1', 'shared')
    registerOneFace(layer, 'b2', 'shared')
    expect(reg.size()).toBe(1)  // one id, held by both bodies

    layer.unregisterBody('b1')
    layer.unregisterBody('b2')
    reg.bumpCycle()

    expect(reg.allocate('crossBodyFree', 'alpha')).not.toBe(reg.allocate('crossBodyFree', 'beta'))
  })

  it('one co-holder re-registering does not orphan the other body\'s live id', () => {
    // Two bodies share one query -> one id, held by both. b1 re-registers: its
    // pre-clear frees the shared id, then a fresh alloc (free list empty, no
    // bumpCycle) mints a new id and rebinds the query key to it. b2's later
    // teardown frees the now-stale id; the free must NOT drop the query key,
    // which by then names b1's live id.
    const layer = new FaceIdLayer(reg, { name: 'coHeldReReg' })
    registerOneFace(layer, 'b1', 'shared')
    registerOneFace(layer, 'b2', 'shared')
    const shared = reg.lookupKey('coHeldReReg', 'shared')!

    registerOneFace(layer, 'b1', 'shared')  // b1 re-registers
    const rebound = reg.lookupKey('coHeldReReg', 'shared')!
    expect(rebound).not.toBe(shared)

    layer.unregisterBody('b2')  // frees the stale `shared` id
    expect(reg.lookupKey('coHeldReReg', 'shared')).toBe(rebound)
    expect(reg.lookup(rebound)).toBeDefined()

    // No leaked record: the cycle promotes only the stale id out of byId.
    reg.bumpCycle()
    expect(reg.lookup(shared)).toBeUndefined()
    expect(reg.lookup(rebound)).toBeDefined()
    expect(reg.size()).toBe(1)
  })

  it('the face layer tags the diagnostic with its configured layer name', () => {
    // FaceIdLayer is reused as the sketch-surface layer; the class name would say
    // nothing you could not read off the noun, the instance name identifies it.
    const layer = new FaceIdLayer(reg, { name: 'sketchSurfaceLike' })
    registerTwoFaces(layer, ['surface@dup', 'surface@dup'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[sketchSurfaceLike] Two faces share')
  })

  it('the edge layer reports duplicate edge queries', () => {
    const layer = new EdgeIdLayer(reg, { name: 'edgeDupWarn' })
    layer.registerBody({
      bodyKey: BODY,
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]),
      segmentToEdge: new Uint32Array([0, 1]),
      edgeQueries: ['edge@dup', 'edge@dup'],
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[edgeDupWarn] Two edges share')
  })

  it('the vertex layer reports duplicate vertex queries too', () => {
    // New with the shared allocator: VertexIdLayer had no diagnostic of its own,
    // so a reuser stacking two vertices on one query collapsed them silently.
    const layer = new VertexIdLayer(reg, { name: 'vertexDupWarn' })
    layer.registerBody({
      bodyKey: BODY,
      vertices: [[0, 0, 0], [1, 0, 0]],
      vertexQueries: ['vtx@dup', 'vtx@dup'],
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[vertexDupWarn] Two vertices share')
  })

  it('the vertex layer keys pick keys on the vertex index, not the write position', () => {
    // Vertex 0 has no query and is skipped, so vertex 1 is written first. Its
    // pick key must still say index 1: the highlight path indexes the full
    // registration list (see computeHighlight), not the drawn subset.
    const layer = new VertexIdLayer(reg, { name: 'vertexSparse' })
    layer.registerBody({
      bodyKey: BODY,
      vertices: [[0, 0, 0], [1, 0, 0]],
      vertexQueries: [undefined as unknown as string, 'vtx@second'],
      perPrimitivePickKeys: true,
    })
    const id = reg.lookupKey('vertexSparse', primitivePickKey(BODY, 1, 'vertexSparse'))
    expect(id).toBeDefined()
    expect(reg.lookup(id!)!.entityKey).toBe('vtx@second')
    expect(reg.size()).toBe(1)
  })
})
