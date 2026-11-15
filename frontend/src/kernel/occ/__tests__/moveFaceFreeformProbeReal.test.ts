// @vitest-environment node
//
// Step 0 of the freeform-neighbour plan: measure the bug report's document
// before writing any strategy. The report
// (`bugreports/20261115_1247_Move_Face_BSplineSurface.md`) inferred the
// neighbour kinds from the feature list; this probe reads them off the rebuilt
// body: each `set1` pick's GeomAbs type, the type of the face across each of its
// edges, that edge's convexity, and the move outcome at d = +-0.5 and +-1.
//
// The pinned table below is a MEASUREMENT, not a ratchet: a strategy rung that
// changes an outcome updates the outcome column in the same commit. The pass
// matrix in moveFaceFreeformReal.test.ts is the ratchet. Canonical edge order
// makes the neighbour and convexity lists stable.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fixture from './fixtures/moveFaceFreeform.json'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, setSketchTopology, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { DisposeScope, withTransientScope } from '../disposeScope'
import { canonicalFaces, canonicalEdges } from '../bodyNames'
import { faceSurfaceName, MoveFaceRefusal } from '../moveFaceSurfaces'
import { applyMoveFace, classifyFaceEdges } from '../moveFace'
import { makeFaceIndexCache, resolveFacesByQuery } from '../../features/shared/faceResolution'
import type { OccModule, OccShape, OccSubShape } from '../occTypes'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()
const topologyBytes = loadTopology()

const BODY = 'body_ESrRWmJlIltOOJE-A1VbLhzR'
const CHAMFER_ID = 'BeXVLtIhoq94L87Qll4xewnr'
const MOVED_ID = 'cHBOnYil8ViF7HhF_DAmiu3T'

/** The face adjacent to `face` across `edge`, ignoring `face` itself. */
function neighbourAcross(occ: OccModule, scope: DisposeScope, body: OccShape, face: OccShape, edge: OccShape): OccShape | null {
  for (const other of canonicalFaces(occ, scope, body) as OccShape[]) {
    if ((other as OccSubShape).IsSame(face as OccSubShape)) continue
    if (canonicalEdges(occ, scope, other).some((e) => (e as OccSubShape).IsSame(edge as OccSubShape))) return other
  }
  return null
}

function isSeamOrDegenerate(occ: OccModule, face: OccShape, edge: OccShape): boolean {
  if (occ.BRep_Tool.Degenerated?.(edge)) return true
  return occ.BRep_Tool.IsClosed_2(edge, face)
}

interface PickProbe {
  type: string
  neighbours: string[]
  convexity: string[]
}

const D_VALUES = [0.5, -0.5, 1, -1] as const

/** A refusal's family, so the pin does not depend on message wording. */
function outcomeFamily(e: unknown): string {
  if (!(e instanceof MoveFaceRefusal) && !(e instanceof Error)) return 'threw'
  const message = (e as Error).message
  if (message.includes('tangent neighbour')) return 'refused: tangent neighbour'
  if (message.includes('cannot be extended')) {
    const name = /neighbour face of type (\w+)/.exec(message)?.[1] ?? '?'
    return `refused: neighbour ${name} cannot be extended`
  }
  if (message.includes('cannot move a')) {
    const name = /cannot move a (\w+) face/.exec(message)?.[1] ?? '?'
    return `refused: cannot move a ${name} face`
  }
  return `refused: ${message}`
}

describe.skipIf(!oc || !solveBytes || !topologyBytes)('move face across freeform neighbours: step 0 probe', () => {
  if (!oc || !solveBytes || !topologyBytes) return
  const occ = oc
  const h = new SharedHarness(occ)
  let body: Body
  let live: DisposeScope
  let shape: OccShape
  let faces: OccShape[]
  let probes: PickProbe[]

  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSketchTopology(topologyBytes)
    const features = fixture.features as Record<string, unknown>[]
    const last = features.findIndex((f) => f.id === MOVED_ID)
    expect(last).toBeGreaterThan(0)
    const result = h.run({
      features: features.slice(0, last),
      part_style: fixture.part_style,
    })
    const snapshot = result._build_state.checkpoints[CHAMFER_ID]?.body_store_snapshot?.[BODY]
    if (!snapshot) throw new Error('the probe document has no body after the chamfer')
    body = snapshot
    live = new DisposeScope()
    const index = makeFaceIndexCache(occ, live, h.table)(body)
    const resolved = resolveFacesByQuery(
      occ, live, h.table, body, index,
      (fixture.picks as { query: string }[]).map((p) => p.query),
    )
    faces = (fixture.picks as { query: string }[]).map((p) => {
      const face = resolved.get(p.query)
      if (!face) throw new Error(`pick did not resolve: ${p.query}`)
      return face
    })
    shape = h.table.get<OccShape>(body.shape!)
    const edgeKind = classifyFaceEdges(occ, live, shape)
    probes = faces.map((face) => {
      const neighbours: string[] = []
      const convexity: string[] = []
      for (const edge of canonicalEdges(occ, live, face) as OccShape[]) {
        if (isSeamOrDegenerate(occ, face, edge)) continue
        convexity.push(edgeKind(edge))
        const neighbour = neighbourAcross(occ, live, shape, face, edge)
        neighbours.push(neighbour === null ? 'none' : faceSurfaceName(occ, live, neighbour))
      }
      return { type: faceSurfaceName(occ, live, face), neighbours, convexity }
    })
  })

  afterAll(() => live?.dispose())

  it('pins the measured pick table and today\'s outcomes', () => {
    const measured = probes.map((probe, i) => {
      const outcome = D_VALUES.map((d) => {
        try {
          withTransientScope((scope) => applyMoveFace(occ, scope, shape, faces[i], d))
          return `${d}:ok`
        } catch (e) {
          return `${d}:${outcomeFamily(e)}`
        }
      })
      return { pick: i + 1, ...probe, outcome }
    })
    console.log(JSON.stringify(measured, null, 2))
    expect(measured).toEqual([
      {
        pick: 1,
        type: 'Plane',
        neighbours: [
          'Plane', 'BSplineSurface', 'BSplineSurface', 'Sphere', 'Sphere', 'Sphere',
          'Sphere', 'Sphere', 'Sphere', 'BSplineSurface', 'BSplineSurface', 'Plane',
        ],
        convexity: [
          'concave', 'concave', 'concave', 'convex', 'convex', 'convex',
          'convex', 'convex', 'convex', 'concave', 'concave', 'concave',
        ],
        outcome: [
          '0.5:refused: neighbour BSplineSurface cannot be extended',
          '-0.5:refused: neighbour BSplineSurface cannot be extended',
          '1:refused: neighbour BSplineSurface cannot be extended',
          '-1:refused: neighbour BSplineSurface cannot be extended',
        ],
      },
      {
        pick: 2,
        type: 'Plane',
        neighbours: ['Plane', 'BSplineSurface', 'BSplineSurface'],
        convexity: ['concave', 'tangent', 'tangent'],
        outcome: [
          '0.5:refused: tangent neighbour',
          '-0.5:refused: tangent neighbour',
          '1:refused: tangent neighbour',
          '-1:refused: tangent neighbour',
        ],
      },
      {
        pick: 3,
        type: 'Plane',
        neighbours: ['Plane', 'BSplineSurface', 'BSplineSurface'],
        convexity: ['concave', 'convex', 'convex'],
        outcome: [
          '0.5:refused: neighbour BSplineSurface cannot be extended',
          '-0.5:refused: neighbour BSplineSurface cannot be extended',
          '1:refused: neighbour BSplineSurface cannot be extended',
          '-1:refused: neighbour BSplineSurface cannot be extended',
        ],
      },
      {
        pick: 4,
        type: 'BSplineSurface',
        neighbours: ['BSplineSurface', 'Sphere', 'Plane', 'Plane'],
        convexity: ['tangent', 'convex', 'convex', 'concave'],
        outcome: [
          '0.5:refused: cannot move a BSplineSurface face',
          '-0.5:refused: cannot move a BSplineSurface face',
          '1:refused: cannot move a BSplineSurface face',
          '-1:refused: cannot move a BSplineSurface face',
        ],
      },
      {
        pick: 5,
        type: 'BSplineSurface',
        neighbours: ['Plane', 'Sphere', 'Plane', 'BSplineSurface'],
        convexity: ['concave', 'convex', 'convex', 'tangent'],
        outcome: [
          '0.5:refused: cannot move a BSplineSurface face',
          '-0.5:refused: cannot move a BSplineSurface face',
          '1:refused: cannot move a BSplineSurface face',
          '-1:refused: cannot move a BSplineSurface face',
        ],
      },
    ])
  }, 300_000)
})
