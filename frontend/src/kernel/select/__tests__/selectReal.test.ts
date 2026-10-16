// @vitest-environment node
//
// Real-kernel tests for the selector engine: build a box through solveLocally,
// select its edges by predicate, and prove the returned queries (a) are the
// exact strings the picking path registers, (b) drive a fillet to the same body
// the oracle 09-fillet-vertical-naming case describes, and (c) survive an
// upstream dimension edit. Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { measureLocally, setSolveLocalsForTest, solveLocally } from '../../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { selectByPredicate } from '@/kernel/select'
import type { Selector } from '@/kernel/select'
import { resolveEdgeQueries } from '@/components/Geometry3D/bodyGeometry'
import type { BodyResult } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, offsetX = 0, offsetY = 0) {
  const ox = offsetX
  const oy = offsetY
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [ox, oy, ox + w, oy], right: [ox + w, oy, ox + w, oy + h],
      top: [ox + w, oy + h, ox, oy + h], left: [ox, oy + h, ox, oy],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function extrude(id: string, distance: number, extra: Record<string, unknown> = {}) {
  return { id, kind: 'extrude', sketch: '$sk1', distance, direction: 'normal', operation: 'new', ...extra }
}

const PARALLEL_Z: Selector = { kind: 'edge', where: { parallel: [0, 0, 1] } }

async function bodiesOf(spec: Record<string, unknown>): Promise<Record<string, BodyResult>> {
  const response = await solveLocally(spec)
  if (!response) throw new Error('unreachable: skipIf guards the kernel')
  return response.bodies as Record<string, BodyResult>
}

function firstBody(bodies: Record<string, BodyResult>): BodyResult {
  const ids = Object.keys(bodies).sort()
  const body = bodies[ids[0]]
  if (!body) throw new Error('solve produced no body')
  return body
}

function faceCount(body: BodyResult): number {
  return body.mesh?.face_data?.length ?? 0
}

describe.skipIf(!oc || !solveBytes)('selectByPredicate (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('selects the four vertical edges of a box and reports their length', async () => {
    const bodies = await bodiesOf({ id: 'sel-basic', features: [rectSketch('sk1', 10, 10), extrude('ex1', 6)] })
    const result = selectByPredicate(PARALLEL_Z, bodies)
    expect(result.queries).toHaveLength(4)
    for (const item of result.items) {
      expect(item.kind).toBe('edge')
      expect(item.geometry).toMatchObject({ kind: 'line', length: 6 })
    }
  })

  it('feeds the selected queries to a fillet and reproduces oracle 09-fillet-vertical-naming', async () => {
    const box = { id: 'sel-oracle', features: [rectSketch('sk1', 20, 10), extrude('ex1', 6)] }
    const queries = selectByPredicate(PARALLEL_Z, await bodiesOf(box)).queries
    expect(queries).toHaveLength(4)

    const filleted = {
      id: 'sel-oracle',
      features: [...box.features, { id: 'fi1', kind: 'fillet', fillet: { edges: queries, radius: 2 } }],
    }
    const measure = await measureLocally(filleted)
    expect(measure).not.toBeNull()
    expect(measure!.faces).toBe(10)
    expect(measure!.volume).toBeCloseTo(1179.398223686155, 6)
  })

  it('returns exactly the queries the picking path registers for the same edges', async () => {
    const bodies = await bodiesOf({ id: 'sel-click', features: [rectSketch('sk1', 10, 10), extrude('ex1', 5)] })
    const body = firstBody(bodies)
    const registered = resolveEdgeQueries(body.edges, body.edge_queries, body.id)
    expect(registered).not.toBeNull()
    // All 12 box edges are named, so the picking path indexes the raw list; the
    // selector's whole-edge list must be that same list, in the same order.
    expect(selectByPredicate({ kind: 'edge' }, bodies).queries).toEqual(registered)
    expect(registered).toHaveLength(12)
  })

  it('the selected queries survive an upstream extrude-distance edit', async () => {
    const base = [rectSketch('sk1', 20, 10), extrude('ex1', 6)]
    const r1 = await solveLocally({ id: 'sel-edit', features: base })
    expect(r1).not.toBeNull()
    const queries = selectByPredicate(PARALLEL_Z, r1!.bodies as Record<string, BodyResult>).queries

    const filletFeature = { id: 'fi1', kind: 'fillet', fillet: { edges: queries, radius: 2 } }
    const r2 = await solveLocally({ id: 'sel-edit', features: [...base, filletFeature] })
    expect(r2).not.toBeNull()
    expect(faceCount(firstBody(r2!.bodies as Record<string, BodyResult>))).toBe(10)

    // Edit the extrude distance 6 -> 10 against the previous build; the stored
    // fillet queries must still resolve to the same edges.
    const taller = [rectSketch('sk1', 20, 10), extrude('ex1', 10), filletFeature]
    const r3 = await solveLocally({ id: 'sel-edit', features: taller }, { prevState: r2!._build_state })
    expect(r3).not.toBeNull()
    expect((r3!.result.fi1 as { status: string }).status).toBe('ok')
    expect(faceCount(firstBody(r3!.bodies as Record<string, BodyResult>))).toBe(10)

    const measure = await measureLocally({ id: 'sel-edit-measure', features: taller })
    expect(measure!.faces).toBe(10)
    expect(measure!.volume).toBeCloseTo(1965.6637061435918, 6)
  })

  it('created_by narrows to the edges a feature made', async () => {
    const bodies = await bodiesOf({
      id: 'sel-created-by',
      features: [
        rectSketch('sk1', 20, 20), extrude('ex1', 10),
        rectSketch('sk2', 6, 6, 7, 7),
        // The bump protrudes past the base top, so the fuse creates new edges
        // attributed to ex2 (a fully contained tool would add none).
        { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 15, direction: 'normal', operation: 'add', merge_target: 'body_ex1' },
      ],
    })
    const madeByEx2 = selectByPredicate({ kind: 'edge', where: { created_by: 'ex2' } }, bodies)
    expect(madeByEx2.queries.length).toBeGreaterThan(0)
    for (const item of madeByEx2.items) expect(item.query).toContain('@ex2')
    // The base feature still owns the edges it made; the two sets partition.
    const madeByEx1 = selectByPredicate({ kind: 'edge', where: { created_by: 'ex1' } }, bodies)
    expect(madeByEx1.queries.length).toBeGreaterThan(0)
    for (const item of madeByEx1.items) expect(item.query).toContain('@ex1')
  })
})
