import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PartDoc, PartEntityDef, PartFeature } from '@/types/cad'
import {
  applyAddEntity, applyAddProjectedEntity, applyAddEntityWithConstraint, applyAddConstraint,
  applyAddPointAtIntersection, applyAddDock, applyAddRect, applyAddCenterRect, applyAddNgon,
  applyAddOffset, applyMoveEntity,
} from '@/utils/yamlMutations/sketch'
import { freshEntityIds, mintEntityId, randomId } from '@/utils/yamlMutations/helpers'

// A sketch straight out of a YAML document that has never been drawn in: none of
// the three lazily-created containers is present. Every mutation that writes one
// has to materialize it, and the point of these tests is WHICH ones it creates.
function bareDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [{ id: 'Sketch1', kind: 'sketch' }] }
}

function populatedDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'Sketch1',
      kind: 'sketch',
      entities: [{ id: 'line1', kind: 'line' }, { id: 'circ1', kind: 'circle' }],
      initial: { line1: [0, 0, 10, 0], circ1: [5, 5, 3] },
      constraints: [{ id: 'c_len', kind: 'distance', target: '$line1', value: 10 }],
    }],
  }
}

const sketch = (doc: PartDoc) => doc.features![0]

/** Make `crypto.getRandomValues` emit each byte value TWICE in a row, so every id
 *  the minter draws is immediately offered again. A collision guard that only
 *  consults the persisted entities -- and not the ids already handed out in the
 *  same run -- therefore mints a duplicate. Robust to extra draws from constraint
 *  id minting, since a repeat is always followed by a fresh value.
 *
 *  Throws rather than wrapping past 0xff: a wrap would re-offer ids that are
 *  already persisted forever, and the minter would spin instead of failing. */
function stubRepeatingBytes(): void {
  let calls = 0
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(arr: T): T => {
      const byte = Math.floor(calls / 2)
      if (byte > 0xff) throw new Error('stubRepeatingBytes: byte pool exhausted, use a smaller fixture')
      calls += 1
      if (arr instanceof Uint8Array) arr.fill(byte)
      return arr
    },
  )
}

/** The 12 bytes `randomId` would have had to draw to produce `id`. */
function bytesOfEntityId(id: string): number[] {
  const raw = atob(id.replace(/-/g, '+').replace(/_/g, '/'))
  return Array.from(raw, c => c.charCodeAt(0))
}

/** Hand the minter back the id of the most recently pushed entity, once per growth
 *  of the entity list, then a fresh value. Whatever draw a mint makes first is
 *  therefore a live id, so the collision is forced without counting how many draws
 *  the mutation spent on constraint ids in between -- which `stubRepeatingBytes`
 *  cannot do, since there the collision partner is positional. Constraint ids draw
 *  6 bytes rather than 12 and are always served a fresh value: `c_<kind>_<id6>`
 *  cannot collide with an entity id, so echoing there would prove nothing. */
function stubEchoingLastEntityId(feature: PartFeature): void {
  let servedAt = -1
  let fresh = 0
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(arr: T): T => {
      if (!(arr instanceof Uint8Array)) return arr
      const entities = feature.entities ?? []
      if (arr.length === 12 && entities.length > 0 && entities.length !== servedAt) {
        servedAt = entities.length
        arr.set(bytesOfEntityId(entities[entities.length - 1].id))
        return arr
      }
      fresh += 1
      if (fresh > 0xff) throw new Error('stubEchoingLastEntityId: byte pool exhausted')
      arr.fill(fresh)
      return arr
    },
  )
}

/** The id `randomId(12)` produces from a constant byte fill. Derived by running the
 *  real minter rather than re-encoding by hand, so this cannot drift from it. */
function idForByte(byte: number): string {
  const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(arr: T): T => {
      if (arr instanceof Uint8Array) arr.fill(byte)
      return arr
    },
  )
  const id = randomId(12)
  spy.mockRestore()
  return id
}

const entityIds = (doc: PartDoc) => sketch(doc).entities!.map(e => e.id)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sketch preamble: container materialization is per mutation', () => {
  it('applyAddEntity creates entities + initial and leaves constraints absent', () => {
    const doc = bareDoc()
    applyAddEntity(doc, 'Sketch1', 'line', [0, 0, 5, 5])
    expect(sketch(doc).entities).toHaveLength(1)
    expect(Object.keys(sketch(doc).initial!)).toHaveLength(1)
    expect(sketch(doc).constraints).toBeUndefined()
    // Key order is YAML-visible, so it is part of the observable output.
    expect(Object.keys(sketch(doc).entities![0])).toEqual(['id', 'kind'])
  })

  it('applyAddProjectedEntity creates entities only', () => {
    const doc = bareDoc()
    applyAddProjectedEntity(doc, 'Sketch1', 'line', '@some/edge/0')
    expect(sketch(doc).entities).toHaveLength(1)
    expect(sketch(doc).entities![0].source).toBe('@some/edge/0')
    expect(Object.keys(sketch(doc).entities![0])).toEqual(['id', 'kind', 'source'])
    // A projection carries no seed geometry, so `initial` must stay untouched.
    expect(sketch(doc).initial).toBeUndefined()
    expect(sketch(doc).constraints).toBeUndefined()
  })

  it('applyAddConstraint creates constraints only', () => {
    const doc = bareDoc()
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    expect(sketch(doc).constraints).toHaveLength(1)
    expect(sketch(doc).entities).toBeUndefined()
    expect(sketch(doc).initial).toBeUndefined()
  })

  it('applyAddEntityWithConstraint creates all three, constraints even when it authors none', () => {
    const doc = bareDoc()
    // No snap target at all: the function pushes the entity and returns before
    // authoring a constraint, so an empty `constraints` can only come from the
    // preamble. That is the pre-refactor behaviour and is pinned here.
    applyAddEntityWithConstraint(doc, 'Sketch1', 'line', [0, 0, 5, 5], 'start', undefined, 'coincident')
    expect(sketch(doc).entities).toHaveLength(1)
    expect(sketch(doc).initial!).toEqual({ [entityIds(doc)[0]]: [0, 0, 5, 5] })
    expect(sketch(doc).constraints).toEqual([])
  })

  it('applyAddPointAtIntersection creates entities + initial only for a free point', () => {
    const doc = bareDoc()
    // Fewer than two usable loci is not an intersection: a free point, no constraint.
    const eid = applyAddPointAtIntersection(doc, 'Sketch1', [2, 3], [])
    expect(eid).not.toBeNull()
    expect(sketch(doc).initial![eid!]).toEqual([2, 3])
    expect(sketch(doc).constraints).toBeUndefined()
  })

  it('applyAddDock materializes all three containers, then bails on a missing host', () => {
    // The host lookup needs `constraints`, so the preamble runs before the bail and
    // the empty containers are the only trace a failed dock leaves.
    const doc = bareDoc()
    expect(applyAddDock(doc, 'Sketch1', [1, 1], 'c_missing')).toBeNull()
    expect(sketch(doc).entities).toEqual([])
    expect(sketch(doc).initial).toEqual({})
    expect(sketch(doc).constraints).toEqual([])
  })

  it('never clobbers containers that already hold content', () => {
    const doc = populatedDoc()
    applyAddEntity(doc, 'Sketch1', 'line', [1, 1, 2, 2])
    applyAddConstraint(doc, 'Sketch1', 'vertical', ['entity:Sketch1:line1'])
    expect(sketch(doc).entities).toHaveLength(3)
    expect(sketch(doc).initial!.line1).toEqual([0, 0, 10, 0])
    expect(sketch(doc).constraints).toHaveLength(2)
  })
})

describe('sketch preamble: an unknown feature id is a silent no-op', () => {
  // A stale feature id from the UI is not an error -- the feature was just
  // deleted -- so every mutation must bail without creating anything.
  it.each([
    ['applyAddEntity', (d: PartDoc) => applyAddEntity(d, 'gone', 'line', [0, 0, 1, 1])],
    ['applyAddProjectedEntity', (d: PartDoc) => applyAddProjectedEntity(d, 'gone', 'line', '@e')],
    ['applyAddEntityWithConstraint',
      (d: PartDoc) => applyAddEntityWithConstraint(d, 'gone', 'line', [0, 0, 1, 1], 'start', undefined, 'coincident')],
    ['applyAddConstraint', (d: PartDoc) => applyAddConstraint(d, 'gone', 'vertical', ['entity:gone:x'])],
    ['applyAddRect', (d: PartDoc) => applyAddRect(d, 'gone', [0, 0], [1, 1])],
    ['applyAddCenterRect', (d: PartDoc) => applyAddCenterRect(d, 'gone', [0, 0], [1, 1])],
    ['applyAddNgon', (d: PartDoc) => applyAddNgon(d, 'gone', [0, 0], [1, 0], 5)],
    ['applyAddOffset', (d: PartDoc) => applyAddOffset(d, 'gone', ['line1'], 1)],
  ])('%s leaves the document untouched', (_name, mutate) => {
    const doc = populatedDoc()
    const before = JSON.stringify(doc)
    expect(() => mutate(doc)).not.toThrow()
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('applyAddPointAtIntersection and applyAddDock return null', () => {
    const doc = populatedDoc()
    expect(applyAddPointAtIntersection(doc, 'gone', [0, 0], ['line1'])).toBeNull()
    expect(applyAddDock(doc, 'gone', [0, 0], 'c_len')).toBeNull()
    expect(doc.features).toHaveLength(1)
  })
})

describe('degenerate rectangles author nothing', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  // drawLogic dispatches add_rect on the second click unconditionally, so a
  // second click on the first corner reaches the mutation with p0 === p1.
  // Four zero-length lines plus eight constraints can never solve: both rect
  // entries bail before authoring anything.
  it('applyAddRect with coincident corners leaves the document untouched', () => {
    const doc = populatedDoc()
    const before = JSON.stringify(doc)
    applyAddRect(doc, 'Sketch1', [3, 4], [3, 4])
    expect(JSON.stringify(doc)).toBe(before)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('applyAddCenterRect with the corner on the center leaves the document untouched', () => {
    const doc = populatedDoc()
    const before = JSON.stringify(doc)
    applyAddCenterRect(doc, 'Sketch1', [3, 4], [3, 4])
    expect(JSON.stringify(doc)).toBe(before)
    expect(warnSpy).toHaveBeenCalled()
  })

  // Only ONE axis has to collapse for the rectangle to be degenerate: dragging
  // along a row or a column authors two zero-length lines (lA/lC or lB/lD) on
  // top of each other, plus coincidents pinning them together. That is the
  // silent document pollution -- nothing on screen, four entities in the YAML.
  it.each([
    ['zero width (corners share x)',  [3, 4] as [number, number], [3, 9] as [number, number]],
    ['zero height (corners share y)', [3, 4] as [number, number], [9, 4] as [number, number]],
    ['a non-finite corner',           [3, 4] as [number, number], [NaN, 9] as [number, number]],
    ['an infinite corner',            [3, 4] as [number, number], [9, Infinity] as [number, number]],
  ])('applyAddRect rejects %s', (_name, p0, p1) => {
    const doc = populatedDoc()
    const before = JSON.stringify(doc)
    applyAddRect(doc, 'Sketch1', p0, p1)
    expect(JSON.stringify(doc)).toBe(before)
    expect(warnSpy).toHaveBeenCalled()
  })

  it.each([
    ['a corner on the center column', [3, 4] as [number, number], [3, 9] as [number, number]],
    ['a corner on the center row',    [3, 4] as [number, number], [9, 4] as [number, number]],
    ['a non-finite corner',           [3, 4] as [number, number], [NaN, 9] as [number, number]],
    ['a non-finite center',           [NaN, 4] as [number, number], [9, 9] as [number, number]],
  ])('applyAddCenterRect rejects %s', (_name, center, corner) => {
    const doc = populatedDoc()
    const before = JSON.stringify(doc)
    applyAddCenterRect(doc, 'Sketch1', center, corner)
    expect(JSON.stringify(doc)).toBe(before)
    expect(warnSpy).toHaveBeenCalled()
  })

  // The guard must not have gone the other way: a real rectangle still lands.
  it('still authors a proper rectangle', () => {
    const doc = populatedDoc()
    applyAddRect(doc, 'Sketch1', [0, 0], [10, 5])
    expect(sketch(doc).entities!.filter(e => e.kind === 'line')).toHaveLength(5)  // line1 + 4
  })
})

describe('entity id minting', () => {
  it('skips an id an existing entity already holds', () => {
    const taken = idForByte(0)
    stubRepeatingBytes()
    const [id] = freshEntityIds([{ id: taken, kind: 'line' }], 1)
    expect(id).not.toBe(taken)
  })

  it('ids within one run are distinct even when the generator repeats itself', () => {
    stubRepeatingBytes()
    const ids = freshEntityIds([], 4)
    expect(new Set(ids).size).toBe(4)
  })

  it('mints nothing for a count of zero', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    expect(freshEntityIds([], 0)).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('takes a supplied id verbatim, even one that collides, without drawing bytes', () => {
    // A caller only supplies an id when it already handed the reference out (the
    // dimension tool targets the projection it makes in the same click). Re-rolling
    // would orphan that reference, so a collision is the caller's problem.
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    const existing: PartEntityDef[] = [{ id: 'line1', kind: 'line' }]
    expect(mintEntityId(existing, 'line1')).toBe('line1')
    expect(spy).not.toHaveBeenCalled()
  })

  it('applyAddEntity keeps a colliding supplied entityId rather than re-rolling', () => {
    const doc = populatedDoc()
    applyAddEntity(doc, 'Sketch1', 'circle', [1, 1, 2], 'line1')
    expect(entityIds(doc)).toEqual(['line1', 'circ1', 'line1'])
  })
})

describe('multi-entity sugar mints distinct ids under a repeating generator', () => {
  it('applyAddRect: four line ids', () => {
    const doc = bareDoc()
    stubRepeatingBytes()
    applyAddRect(doc, 'Sketch1', [0, 0], [10, 5])
    const ids = entityIds(doc)
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
  })

  it('applyAddNgon: one line id per side', () => {
    const doc = bareDoc()
    stubRepeatingBytes()
    applyAddNgon(doc, 'Sketch1', [0, 0], [5, 0], 6)
    const ids = entityIds(doc)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
  })

  it('applyAddCenterRect: the center point is minted after the four lines are pushed', () => {
    // The point is minted between `_applyRectLines` and the diagonal midpoints, so
    // it must see the lines that call already pushed. The echoing stub is what
    // makes this bite: a mint reading a snapshot of `entities` taken before
    // `_applyRectLines` would accept the echoed line id and duplicate it.
    const doc = bareDoc()
    stubEchoingLastEntityId(sketch(doc))
    applyAddCenterRect(doc, 'Sketch1', [0, 0], [4, 2])
    const ids = entityIds(doc)
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
    const point = sketch(doc).entities!.find(e => e.kind === 'point')!
    expect(ids.slice(0, 4)).not.toContain(point.id)
  })

  it('applyAddOffset: one clone id per source, drawn against the live entity list', () => {
    // Splines are cloned at source with no relationship constraint, so every byte
    // the stub hands out goes to an entity id. That makes the run sensitive to
    // whether each clone is visible to the next draw: a minter reading a set
    // captured before the loop would hand the second clone the first clone's id.
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'Sketch1',
        kind: 'sketch',
        entities: [
          { id: 's1', kind: 'spline' }, { id: 's2', kind: 'spline' }, { id: 's3', kind: 'spline' },
        ],
        initial: { s1: [0, 0, 1, 1], s2: [2, 2, 3, 3], s3: [4, 4, 5, 5] },
        constraints: [],
      }],
    }
    stubRepeatingBytes()
    applyAddOffset(doc, 'Sketch1', ['s1', 's2', 's3'], 1)
    const clones = entityIds(doc).slice(3)
    expect(clones).toHaveLength(3)
    expect(new Set(clones).size).toBe(3)
    expect(sketch(doc).constraints).toEqual([])  // spline: copy only, no relationship
  })
})

describe('applyMoveEntity drag-frame adoption', () => {
  it('adopts the solved frame and does NOT also apply the delta', () => {
    const doc = populatedDoc()
    // The frame already reflects the translation the pointer performed; applying
    // `delta` on top of it would translate the entity twice. The frame is
    // deliberately NOT `initial + delta` (that would be [2,3,12,3]): if it were,
    // the correct result and the double-translated one would agree on line1 and
    // only the circ1 assertion would carry the claim.
    applyMoveEntity(doc, 'Sketch1', 'line1', [2, 3], { line1: [1, 1, 11, 1], circ1: [7, 8, 3] })
    expect(sketch(doc).initial!.line1).toEqual([1, 1, 11, 1])
    expect(sketch(doc).initial!.circ1).toEqual([7, 8, 3])
  })

  it('applies the delta when no frame is supplied', () => {
    const doc = populatedDoc()
    applyMoveEntity(doc, 'Sketch1', 'line1', [2, 3])
    expect(sketch(doc).initial!.line1).toEqual([2, 3, 12, 3])
    expect(sketch(doc).initial!.circ1).toEqual([5, 5, 3])  // untouched: only the frame path is global
  })

  it('rounds adopted params and skips unknown or param-count-mismatched entries', () => {
    const doc = populatedDoc()
    applyMoveEntity(doc, 'Sketch1', 'line1', [2, 3], {
      line1: [0.1234567891, 0, 10, 0],
      ghost: [1, 2],   // not in initial: must not be created
      circ1: [6, 6],   // wrong param count for a circle: must not corrupt
    })
    expect(sketch(doc).initial!.line1[0]).toBe(0.123457)
    expect(sketch(doc).initial!.ghost).toBeUndefined()
    expect(sketch(doc).initial!.circ1).toEqual([5, 5, 3])
  })

  it('an empty frame still counts as adopted and suppresses the delta', () => {
    const doc = populatedDoc()
    applyMoveEntity(doc, 'Sketch1', 'line1', [2, 3], {})
    expect(sketch(doc).initial!.line1).toEqual([0, 0, 10, 0])
  })
})
