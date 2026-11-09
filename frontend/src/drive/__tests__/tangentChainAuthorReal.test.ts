// @vitest-environment node
//
// The ordinary parametric-CAD way to draw a chain: lines and arcs joined end to
// end, a vertex-to-vertex coincident at each joint, a tangent per joint, and the
// far ends pinned. Four arcs alternate direction between two fixed lines. The
// Rust suite covers convergence from a 10 percent bulge; this authoring test
// checks the document the mutations build settles, so inspecting its docHash
// returns the same geometry.
// Real kernel, gated like the other drive real suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { emptyDriveDoc, runHeadless } from '../headlessOps'
import { docHashOf } from '../docHash'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

type Arc = { c: [number, number]; r: number; a0: number; a1: number }

// line 1: (-4,0)->(-3,0); line 2: (3,0)->(4,0); the arcs meet at (-3,0),
// (-2,-1), (0,-3), (1,-2), (3,0). Each arc is stored CCW.
const ARCS: Arc[] = [
  { c: [-3, -1], r: 1, a0: 0, a1: 90 },
  { c: [0, -1], r: 2, a0: 180, a1: 270 },
  { c: [0, -2], r: 1, a0: 270, a1: 360 },
  { c: [3, -2], r: 2, a0: 90, a1: 180 },
]

function at(a: Arc, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180
  return [a.c[0] + a.r * Math.cos(t), a.c[1] + a.r * Math.sin(t)]
}

// The authored through point: the exact arc midpoint. The Rust chain test
// pushes it 10 percent of the chord along the bulge to force a real solve; here
// the point is exact so the write-back fixed point is what gets exercised.
function midpoint(a: Arc): [number, number] {
  return at(a, (a.a0 + a.a1) / 2)
}

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

// The stored start point of each authored arc is named by the key the reply
// reports: a1 stores P2 at start, a2 P2, a3 P3, a4 P5.
function scaledArcs(scale: number): Arc[] {
  return ARCS.map(a => ({ c: [a.c[0] * scale, a.c[1] * scale], r: a.r * scale, a0: a.a0, a1: a.a1 }))
}

function chainSteps(scale = 1): ScriptStep[] {
  const arcs = scaledArcs(scale)
  const p1 = at(arcs[0], arcs[0].a1)
  const p2 = at(arcs[0], arcs[0].a0)
  const p3 = at(arcs[1], arcs[1].a1)
  const p4 = at(arcs[2], arcs[2].a1)
  const p5 = at(arcs[3], arcs[3].a0)
  const throughOf = (a: Arc) => midpoint(a)
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [-4 * scale, 0, ...p1], entityId: 'l1' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [...p5, 4 * scale, 0], entityId: 'l2' }),
    m({
      type: 'add_three_point_arc', featureId: 'sk1',
      start: p1, through: throughOf(arcs[0]), end: p2,
      startRef: 'vertex:sk1:l1:end', entityId: 'a1',
    }),
    m({
      type: 'add_three_point_arc', featureId: 'sk1',
      start: p2, through: throughOf(arcs[1]), end: p3,
      startRef: 'vertex:sk1:a1:start', entityId: 'a2',
    }),
    m({
      type: 'add_three_point_arc', featureId: 'sk1',
      start: p3, through: throughOf(arcs[2]), end: p4,
      startRef: 'vertex:sk1:a2:end', entityId: 'a3',
    }),
    m({
      type: 'add_three_point_arc', featureId: 'sk1',
      start: p4, through: throughOf(arcs[3]), end: p5,
      startRef: 'vertex:sk1:a3:end', endRef: 'vertex:sk1:l2:start', entityId: 'a4',
    }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['entity:sk1:l1'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['entity:sk1:l2'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['vertex:sk1:a1:start'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['vertex:sk1:a2:end'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['vertex:sk1:a3:end'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'tangent', targets: ['entity:sk1:l1', 'entity:sk1:a1'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'tangent', targets: ['entity:sk1:a1', 'entity:sk1:a2'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'tangent', targets: ['entity:sk1:a2', 'entity:sk1:a3'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'tangent', targets: ['entity:sk1:a3', 'entity:sk1:a4'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'tangent', targets: ['entity:sk1:a4', 'entity:sk1:l2'] }),
  ]
}

function arcParams(sketch: SketchFeature, id: string): number[] {
  const params = (sketch.initial ?? {})[id]
  if (!params || params.length !== 5) throw new Error(`no arc params for ${id}`)
  return params
}

function arcPoint(params: number[], deg: number): [number, number] {
  const t = (deg * Math.PI) / 180
  return [params[0] + params[2] * Math.cos(t), params[1] + params[2] * Math.sin(t)]
}

async function authorAndInspect(scale: number, docId: string): Promise<{
  first: Awaited<ReturnType<typeof runHeadless>>
  inspected: Awaited<ReturnType<typeof runHeadless>>
}> {
  const first = await runHeadless({
    doc: emptyDriveDoc(),
    steps: chainSteps(scale),
    docId,
  })
  expect(first.outcome.ok).toBe(true)
  expect(first.features).toEqual([])

  const arcs = scaledArcs(scale)
  const sketch = first.doc!.features!.find(f => f.id === 'sk1') as SketchFeature
  for (let i = 0; i < arcs.length; i++) {
    const exact = arcs[i]
    const params = arcParams(sketch, `a${i + 1}`)
    for (const [key, deg] of [['start', exact.a0], ['end', exact.a1]] as const) {
      const got = arcPoint(params, deg)
      const want = at(exact, deg)
      // The write-back rounds each param to the 1e-6 document grid, so an
      // endpoint can move by one grid step per component; allow the
      // Euclidean sum of two steps.
      expect(
        Math.hypot(got[0] - want[0], got[1] - want[1]),
        `a${i + 1} ${key}: got ${got} want ${want}`,
      ).toBeLessThan(2e-6)
    }
  }

  const inspected = await runHeadless({
    doc: first.doc as PartDoc,
    steps: [],
    docId: `${docId}-inspect`,
  })
  expect(inspected.ok).toBe(true)
  return { first, inspected }
}

describe.skipIf(!ready)('a tangent chain authored through mutations (real OCC + Rust solver)', () => {
  it('solves every arc and stays a fixed point on inspection', async () => {
    const { first, inspected } = await authorAndInspect(1, 'tangent-chain-author')
    expect(docHashOf(inspected.doc as PartDoc)).toBe(docHashOf(first.doc as PartDoc))
  }, 240_000)

  // The scale ~1 case the retired f32 envelope hid: a 1e-6 grid step breaks the
  // tangency rows' 1e-7 verdict at this size, so the LM moves the seed on every
  // cold solve. The solver reports that move, the write-back rounds it to the
  // grid, and the next inspection must land on the same bytes. Before the
  // solver-owned report the frontend envelope absorbed it; without either, a
  // no-op inspection would have re-spelled the document.
  it('is still a fixed point when the whole chain is scaled to about one unit', async () => {
    const { first, inspected } = await authorAndInspect(0.125, 'tangent-chain-small')
    expect(docHashOf(inspected.doc as PartDoc)).toBe(docHashOf(first.doc as PartDoc))
  }, 240_000)
})
