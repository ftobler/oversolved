// @vitest-environment node
//
// A multi-region extrude's caps are keyed by their OWN profile entities, never
// by the region's position in the loop order (plan bug-multi-region-cap-identity).
//
// The report (MCP practice 02_cadquery cq-electronics rpi3b) found two faults on
// the same face: with three disjoint regions A, B, C an add-extrude named B's
// cap `g1`, so deleting A renamed B to `g0` and handed `g1` to C; a face sketch
// stored on B then resolved to C without a warning. And a multi-region cap's
// ancestral tokens were empty, so both caps fell back to the body-wide profile
// queries and could not be told apart by their lineage.
//
// Every case here is a real OCC build with the Rust sketch solver. Skips when
// either is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { type BuildResponse } from '../../builder'
import {
  constructionUuidToken,
  isConstructionUuidId,
  makeAncestryQuery,
  parseAncestry,
} from '../../query'
import { mintFaceUuid, deriveEdgeUuid, legacyCapFacePath, sideFacePath } from '../../constructionName'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../volume'
import type { OccShape } from '../occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Feature = Record<string, unknown>
type Mesh = {
  face_data: Array<{ centroid: number[]; normal: number[]; surface_type: string; area: number }>
  face_queries: string[]
  face_uuids: (string | null)[]
}

const CHIP_SIZE = 4
const CHIP_DISTANCE = 1
const PLATE_TOP = 2
const PLATE_DISTANCE = 60
// The report's three chips, one per authored prefix.
const CHIP_X: Record<string, number> = { a: -20, b: 0, c: 20 }

/** One axis-aligned rectangle on a datum plane with its own entity prefix. */
function rectEntities(prefix: string, cx: number, cy: number, w = CHIP_SIZE, h = CHIP_SIZE) {
  const entities = [
    { id: `${prefix}_bottom`, kind: 'line' as const },
    { id: `${prefix}_right`, kind: 'line' as const },
    { id: `${prefix}_top`, kind: 'line' as const },
    { id: `${prefix}_left`, kind: 'line' as const },
  ]
  const x0 = cx - w / 2
  const x1 = cx + w / 2
  const y0 = cy - h / 2
  const y1 = cy + h / 2
  const initial = {
    [`${prefix}_bottom`]: [x0, y0, x1, y0],
    [`${prefix}_right`]: [x1, y0, x1, y1],
    [`${prefix}_top`]: [x1, y1, x0, y1],
    [`${prefix}_left`]: [x0, y1, x0, y0],
  }
  const constraints = [
    { id: `${prefix}_c1`, kind: 'coincident' as const, a: { entity: `${prefix}_bottom`, point: 'end' as const }, b: { entity: `${prefix}_right`, point: 'start' as const } },
    { id: `${prefix}_c2`, kind: 'coincident' as const, a: { entity: `${prefix}_right`, point: 'end' as const }, b: { entity: `${prefix}_top`, point: 'start' as const } },
    { id: `${prefix}_c3`, kind: 'coincident' as const, a: { entity: `${prefix}_top`, point: 'end' as const }, b: { entity: `${prefix}_left`, point: 'start' as const } },
    { id: `${prefix}_c4`, kind: 'coincident' as const, a: { entity: `${prefix}_left`, point: 'end' as const }, b: { entity: `${prefix}_bottom`, point: 'start' as const } },
    { id: `${prefix}_h1`, kind: 'horizontal' as const, target: { entity: `${prefix}_bottom` } },
    { id: `${prefix}_h2`, kind: 'horizontal' as const, target: { entity: `${prefix}_top` } },
    { id: `${prefix}_v1`, kind: 'vertical' as const, target: { entity: `${prefix}_right` } },
    { id: `${prefix}_v2`, kind: 'vertical' as const, target: { entity: `${prefix}_left` } },
    { id: `${prefix}_l1`, kind: 'length' as const, target: { entity: `${prefix}_bottom` }, value: w },
    { id: `${prefix}_l2`, kind: 'length' as const, target: { entity: `${prefix}_left` }, value: h },
  ]
  return { entities, initial, constraints }
}

/** A sketch carrying the named rectangles in the given authoring order. */
function chipsSketch(id: string, prefixes: string[], plane = '@builtin_plane_top'): Feature {
  const rects = prefixes.map((prefix, i) =>
    rectEntities(prefix, CHIP_X[prefix] ?? -20 + i * 20, 0))
  return {
    id, kind: 'sketch', label: 'Chips', plane,
    entities: rects.flatMap((r) => r.entities),
    initial: Object.assign({}, ...rects.map((r) => r.initial)),
    constraints: rects.flatMap((r) => r.constraints),
  }
}

/** The 60 x 2 plate the add cases sit on. */
function plateFeatures(): Feature[] {
  const plate = rectEntities('plate', 0, 0, PLATE_DISTANCE, 20)
  return [
    { id: 'sk1', kind: 'sketch', label: 'Plate', plane: '@builtin_plane_top', ...plate },
    { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: PLATE_TOP, operation: 'new' } },
  ]
}

function chipExtrude(id: string, sketchId: string, operation: 'new' | 'add'): Feature {
  return { id, kind: 'extrude', extrude: { sketch: `@${sketchId}`, distance: CHIP_DISTANCE, operation } }
}

/** A union of a plate and three chips, the report's add shape. */
function plateAndChips(prefixes: string[]): Feature[] {
  return [
    ...plateFeatures(),
    { id: 'pl2', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: PLATE_TOP } },
    chipsSketch('sk2', prefixes, '@pl2'),
    chipExtrude('ex2', 'sk2', 'add'),
  ]
}

function chipCapY(operation: 'new' | 'add'): number {
  return operation === 'add' ? PLATE_TOP + CHIP_DISTANCE : CHIP_DISTANCE
}

function allMeshes(result: BuildResponse): Mesh[] {
  return Object.values((result.bodies ?? {}) as Record<string, Record<string, unknown>>)
    .map((b) => b.mesh as Mesh | undefined)
    .filter((m): m is Mesh => m !== undefined)
}

/** The upward flat cap whose centroid sits at world (x, y). */
function capAt(result: BuildResponse, x: number, y: number): { uuid: string; query: string; centroid: number[] } {
  for (const mesh of allMeshes(result)) {
    const hit = mesh.face_data.findIndex((fd) =>
      fd.surface_type === 'flatface' &&
      fd.normal[1] > 0.99 &&
      Math.abs(fd.centroid[0] - x) < 1e-6 &&
      Math.abs(fd.centroid[1] - y) < 1e-6,
    )
    if (hit < 0) continue
    const uuid = mesh.face_uuids[hit]
    if (!uuid) throw new Error(`the cap at (${x}, ${y}) is unnamed`)
    return { uuid, query: mesh.face_queries[hit], centroid: mesh.face_data[hit].centroid }
  }
  throw new Error(`no upward cap at (${x}, ${y})`)
}


function ancestryOf(query: string): string[] {
  return parseAncestry(query)[0]
}

/** `sk2`'s entity tokens, one per rectangle prefix. */
function regionTokens(sketchId: string, prefix: string): string[] {
  return ['bottom', 'right', 'top', 'left']
    .map((side) => `@${sketchId}/${prefix}_${side}`)
    .sort()
}

function withoutUuid(query: string): string {
  const [ids, type] = parseAncestry(query)
  return makeAncestryQuery(ids.filter((id) => !isConstructionUuidId(id)), type)
}

function withUuid(query: string, uuid: string): string {
  const [ids, type] = parseAncestry(query)
  return makeAncestryQuery(
    ids.map((id) => (isConstructionUuidId(id) ? constructionUuidToken(uuid) : id)),
    type,
  )
}

/**
 * A face sketch on `query`, carrying one small circle so the solve has
 * geometry. Its resolved frame origin is the cap centroid; that is the fact the
 * report's silent jump moved.
 */
function probeSketch(id: string, query: string): Feature {
  return {
    id, kind: 'sketch', label: 'Probe', plane: query,
    entities: [{ id: 'mark', kind: 'circle' }],
    initial: { mark: [0, 0, 1] },
    constraints: [],
  }
}

function probeFrameOrigin(result: BuildResponse, id: string): number[] | undefined {
  const plane = (result.result as Record<string, Record<string, unknown>>)[id]?.plane_transform as
    | { origin?: number[] }
    | undefined
  return plane?.origin
}

describe.skipIf(!oc || !solveBytes)('multi-region cap identity (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  const twoRegions = (): Feature[] => [chipsSketch('sk2', ['a', 'b']), chipExtrude('ex2', 'sk2', 'new')]
  const threeRegions = (): Feature[] => [chipsSketch('sk2', ['a', 'b', 'c']), chipExtrude('ex2', 'sk2', 'new')]

  it('RC1: deleting an earlier region leaves a later region cap uuid unchanged (new)', () => {
    const before = h.run({ features: twoRegions() })
    const bBefore = capAt(before, 0, chipCapY('new'))

    const after = h.run({ features: [chipsSketch('sk2', ['b']), chipExtrude('ex2', 'sk2', 'new')] })
    const bAfter = capAt(after, 0, chipCapY('new'))

    expect(bAfter.uuid).toBe(bBefore.uuid)
  })

  it('RC1: a stored cap query follows B, never jumps to C, after A is deleted (new)', () => {
    const before = h.run({ features: threeRegions() })
    const bBefore = capAt(before, 0, chipCapY('new'))
    const cBefore = capAt(before, 20, chipCapY('new'))
    expect(cBefore.uuid).not.toBe(bBefore.uuid)

    const after = h.run({
      features: [chipsSketch('sk2', ['b', 'c']), chipExtrude('ex2', 'sk2', 'new'), probeSketch('sk7', bBefore.query)],
    })
    expect(h.res(after, 'ex2').status).toBe('ok')
    const origin = probeFrameOrigin(after, 'sk7')
    expect(origin, 'the probe face sketch resolved').toBeDefined()
    expect(origin![0], 'sk7 stays on B').toBeCloseTo(0, 6)
    expect(origin![0], 'sk7 did not jump to C').not.toBeCloseTo(20, 6)
  })

  it('RC1: inserting a region before B leaves B cap uuid unchanged', () => {
    const before = h.run({ features: twoRegions() })
    const bBefore = capAt(before, 0, chipCapY('new'))

    // B is authored first now, so it is the earlier region in the loop order.
    const after = h.run({ features: [chipsSketch('sk2', ['b', 'a']), chipExtrude('ex2', 'sk2', 'new')] })
    const bAfter = capAt(after, 0, chipCapY('new'))

    expect(bAfter.uuid).toBe(bBefore.uuid)
  })

  it('RC1: a single region keeps its cap uuid across 1 <-> N', () => {
    const one = h.run({ features: [chipsSketch('sk2', ['a']), chipExtrude('ex2', 'sk2', 'new')] })
    const aOne = capAt(one, CHIP_X.a, chipCapY('new'))

    const two = h.run({ features: [chipsSketch('sk2', ['a', 'b']), chipExtrude('ex2', 'sk2', 'new')] })
    const aTwo = capAt(two, CHIP_X.a, chipCapY('new'))
    expect(aTwo.uuid).toBe(aOne.uuid)

    const back = h.run({ features: [chipsSketch('sk2', ['a']), chipExtrude('ex2', 'sk2', 'new')] })
    expect(capAt(back, CHIP_X.a, chipCapY('new')).uuid).toBe(aOne.uuid)
  })

  it('RC1: deleting an earlier region on an add leaves B cap unchanged, and the query follows B', () => {
    const before = h.run({ features: plateAndChips(['a', 'b', 'c']) })
    const bBefore = capAt(before, 0, chipCapY('add'))
    expect(ancestryOf(bBefore.query)).toContain('@sk2/b_bottom')

    const after = h.run({
      features: [...plateAndChips(['b', 'c']), probeSketch('sk7', bBefore.query)],
    })
    expect(h.res(after, 'ex2').status).toBe('ok')
    const bAfter = capAt(after, 0, chipCapY('add'))
    expect(bAfter.uuid).toBe(bBefore.uuid)
    expect(probeFrameOrigin(after, 'sk7')![0]).toBeCloseTo(0, 6)
    expect(capAt(after, 20, chipCapY('add')).uuid).not.toBe(bBefore.uuid)
  })

  it('RC2: each cap names its own region, never another region or the target body (new and add)', () => {
    for (const operation of ['new', 'add'] as const) {
      const spec = operation === 'new'
        ? { features: threeRegions() }
        : { features: plateAndChips(['a', 'b', 'c']) }
      const result = h.run(spec)
      const b = capAt(result, CHIP_X.b, chipCapY(operation))
      const c = capAt(result, CHIP_X.c, chipCapY(operation))

      expect(ancestryOf(b.query).filter((id) => id.startsWith('@sk2/')), `B cap ancestry (${operation})`)
        .toEqual(regionTokens('sk2', 'b'))
      expect(ancestryOf(b.query).filter((id) => id.startsWith('@sk1/')), `B cap has no target tokens (${operation})`)
        .toEqual([])
      expect(ancestryOf(c.query).filter((id) => id.startsWith('@sk2/')), `C cap ancestry (${operation})`)
        .toEqual(regionTokens('sk2', 'c'))
      expect(ancestryOf(b.query)).not.toEqual(ancestryOf(c.query))
    }
  })

  it('RC1/RC2: a 180 degree revolve fan-out keys its caps by the region, not the group order', () => {
    const axis = {
      id: 'skax', kind: 'sketch', label: 'Axis', plane: '@builtin_plane_front',
      entities: [{ id: 'ax', kind: 'line' }],
      initial: { ax: [0, 0, 0, 1] }, constraints: [],
    }
    // Two disjoint rectangles to one side of the Y axis; a 180 degree revolve
    // puts the far cap at the mirrored x.
    const rects = [rectEntities('a', 5, 0, 2, 2), rectEntities('b', 15, 0, 2, 2)]
    const sketch = {
      id: 'skr', kind: 'sketch', label: 'Profiles', plane: '@builtin_plane_front',
      entities: rects.flatMap((r) => r.entities),
      initial: Object.assign({}, ...rects.map((r) => r.initial)),
      constraints: rects.flatMap((r) => r.constraints),
    }
    const revolve = (angle: number): Feature => ({
      id: 'rv1', kind: 'revolve', angle, axis: '@skax/ax', operation: 'new', sketch: '@skr',
    })

    const endCap = (result: BuildResponse, x: number) => {
      for (const mesh of allMeshes(result)) {
        const hit = mesh.face_data.findIndex((fd) =>
          fd.surface_type === 'flatface' &&
          Math.abs(fd.normal[2]) > 0.99 &&
          Math.abs(fd.centroid[0] - x) < 1e-6,
        )
        if (hit < 0) continue
        const uuid = mesh.face_uuids[hit]
        if (!uuid) throw new Error(`the revolve cap at x=${x} is unnamed`)
        return { uuid, query: mesh.face_queries[hit] }
      }
      throw new Error(`no revolve cap at x=${x}`)
    }

    const before = h.run({ features: [axis, sketch, revolve(180)] })
    expect(h.res(before, 'rv1').status).toBe('ok')
    const bBefore = endCap(before, -15)

    const after = h.run({
      features: [
        axis,
        { ...sketch, entities: rectEntities('b', 15, 0, 2, 2).entities, initial: rectEntities('b', 15, 0, 2, 2).initial, constraints: rectEntities('b', 15, 0, 2, 2).constraints },
        revolve(180),
      ],
    })
    expect(h.res(after, 'rv1').status).toBe('ok')
    expect(endCap(after, -15).uuid).toBe(bBefore.uuid)
    expect(ancestryOf(bBefore.query).filter((id) => id.startsWith('@skr/'))).toEqual(regionTokens('skr', 'b'))
  })

  it('migration: a legacy cap rim edge still fillets with the same volume', () => {
    const base: Feature[] = [chipsSketch('sk2', ['a']), chipExtrude('ex2', 'sk2', 'new')]
    const built = h.run({ features: base })
    const cap = capAt(built, CHIP_X.a, chipCapY('new'))
    const partRow = (built.bodies as Record<string, Record<string, unknown>>)['body_ex2']
    const edgeQueries = (partRow.edge_queries as string[] | undefined) ?? []
    // The end cap's rim edge on one of its four sides: same ancestry token, the
    // upward classifier, and the single cap-side pair.
    const liveEdge = edgeQueries.find((q) =>
      q.includes('@sk2/a_left') && q.includes('@cls_yp'))
    expect(liveEdge, 'the top rim edge on the left side').toBeDefined()

    const legacyCap = mintFaceUuid(legacyCapFacePath('ex2', 'end'))
    const sideUuid = mintFaceUuid(sideFacePath('ex2', 'sk2/a_left'))
    const legacyEdge = deriveEdgeUuid(legacyCap, sideUuid)
    expect(legacyEdge).not.toBe(afterUuid(liveEdge!))
    const legacyQuery = withUuid(liveEdge!, legacyEdge)

    const filletVolume = (edgeQuery: string): number => {
      const r = h.run({
        features: [...base, { id: 'fi1', kind: 'fillet', fillet: { edges: [edgeQuery], radius: 0.5 } }],
      })
      expect(h.res(r, 'fi1').status).toBe('ok')
      const state = r._build_state!
      const last = state.feature_order[state.feature_order.length - 1]
      const part = (state.checkpoints[last].body_store_snapshot as Record<string, { shape: unknown }>)['body_ex2']
      const scope = new DisposeScope()
      try {
        return volumeOf(oc!, scope, h.table.get<OccShape>(part.shape as never))
      } finally {
        scope.dispose()
      }
    }
    expect(filletVolume(legacyQuery)).toBeCloseTo(filletVolume(liveEdge!), 9)
    expect(cap.uuid).toBeTruthy()
  })

  it('migration: a legacy bare single-region cap query still resolves, g1 and wrong-token picks stay red', () => {
    // The current single-group cap, and the pre-fix path it replaces.
    const one = h.run({ features: [chipsSketch('sk2', ['a']), chipExtrude('ex2', 'sk2', 'new')] })
    const current = capAt(one, CHIP_X.a, chipCapY('new'))
    const legacyUuid = mintFaceUuid('ex2|cap|end')
    expect(current.uuid, 'the cap identity moved off the legacy path').not.toBe(legacyUuid)

    const legacyQuery = withUuid(current.query, legacyUuid)
    const migrated = h.run({
      features: [chipsSketch('sk2', ['a']), chipExtrude('ex2', 'sk2', 'new'), probeSketch('sk7', legacyQuery)],
    })
    expect(h.res(migrated, 'sk7').status, 'legacy bare single-region cap resolves').not.toBe('exception')
    expect(probeFrameOrigin(migrated, 'sk7')![0]).toBeCloseTo(CHIP_X.a, 6)

    // A legacy g1 pick has no hand-off: the index it carried is exactly the
    // unreliable part, so the feature goes red rather than binding another cap.
    const multi = h.run({ features: threeRegions() })
    const b = capAt(multi, CHIP_X.b, chipCapY('new'))
    const g1Query = withUuid(b.query, mintFaceUuid('ex2|cap|end|g1'))
    const g1 = h.run({
      features: [chipsSketch('sk2', ['b', 'c']), chipExtrude('ex2', 'sk2', 'new'), probeSketch('sk7', g1Query)],
    })
    expect(h.res(g1, 'sk7').status).toBe('exception')
    expect(String(h.res(g1, 'sk7').exception)).toContain('did not resolve')

    // A legacy bare cap whose query carries another region's tokens (the RC2
    // damage on the per-group path) is not a verified hand-off either.
    const a = capAt(multi, CHIP_X.a, chipCapY('new'))
    const allTokens = [...regionTokens('sk2', 'a'), ...regionTokens('sk2', 'b'), ...regionTokens('sk2', 'c')].sort()
    const wrongIds = parseAncestry(a.query)[0].filter((id) =>
      !id.startsWith('@sk2/') && !isConstructionUuidId(id))
    const wrongQuery = makeAncestryQuery(
      [constructionUuidToken(mintFaceUuid('ex2|cap|end')), ...wrongIds, ...allTokens],
      'flatface',
    )
    const wrong = h.run({
      features: [chipsSketch('sk2', ['a', 'b']), chipExtrude('ex2', 'sk2', 'new'), probeSketch('sk7', wrongQuery)],
    })
    expect(h.res(wrong, 'sk7').status).toBe('exception')
    expect(String(h.res(wrong, 'sk7').exception)).toContain('did not resolve')
  })

  it('a fresh cap query resolves through its own UUID, and its uuid differs from its stripped-ancestry answer', () => {
    const result = h.run({ features: plateAndChips(['a', 'b']) })
    const b = capAt(result, 0, chipCapY('add'))
    expect(afterUuid(b.query)).toBe(b.uuid)
    // The ancestral net is still usable: it reaches B (possibly among siblings),
    // never a foreign branch.
    expect(ancestryOf(b.query)).toContain('@sk2/b_bottom')
    expect(withoutUuid(b.query).startsWith('?')).toBe(true)
  })
})

/** The `@u|` uuid token of a query, or null. */
function afterUuid(query: string): string | null {
  const [ids] = parseAncestry(query)
  const token = ids.find((id) => id.startsWith('@u|'))
  return token === undefined ? null : token.slice(3)
}
