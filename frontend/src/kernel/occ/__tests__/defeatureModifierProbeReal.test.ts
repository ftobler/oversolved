// @vitest-environment node
//
// Step 0 of the delete-face-on-edge-modifier plan: measure the report document
// (`bugreports/20261115_1255_Delete_Face_2.md`) before writing any strategy.
// The plan inferred the cause from the feature list; this probe reads it off
// the rebuilt body: each picked modifier face's GeomAbs surface class, the class
// of every face in its neighbour ring, which rung-1 guard the raw
// `BRepAlgoAPI_Defeaturing` verdict implies, the verdict per face (`IsDone`,
// `IsDeleted`), its wall time, and the untouched shape's validity and volume.
// The adapter's outcome is the pass matrix's job (defeatureModifierReal.ts):
// the raw call still reports the silent IsDeleted no-op the pin records, and
// rung 2 is what carries the feature.
//
// The pinned table below is a MEASUREMENT, not a ratchet: a strategy rung that
// changes an outcome updates the outcome columns in the same commit. The pass
// matrix in defeatureModifierReal.test.ts is the ratchet.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fixture from './fixtures/deleteFaceModifier.json'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, setSketchTopology, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { DisposeScope } from '../disposeScope'
import { neighbourRing, faceGroups } from '../defeature'
import { faceSurfaceName } from '../moveFaceSurfaces'
import { noProgress } from '../defaultArgs'
import { canonicalEdges } from '../partNames'
import { classifyFaceEdges } from '../moveFace'
import { exploreSolids } from '../booleans'
import { isValidShape } from '../edgeModifier'
import { volumeOf } from '../volume'
import { makeFaceIndexCache, resolveFacesByQuery } from '../../features/shared/faceResolution'
import type { OccModule, OccShape, OccSubShape, OccDefeaturingMaker } from '../occTypes'
import type { PartSolid } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()
const topologyBytes = loadTopology()

const PART = 'body_ESrRWmJlIltOOJE-A1VbLhzR'
const CHAMFER_ID = 'BeXVLtIhoq94L87Qll4xewnr'
const CHAMFER_DELETE = 'GpyTc0jipDArcxEoOFcx_DBl'

/** The boundary edges of the picked faces with their classified kind, the
 *  neighbour surface across each, and the edge length: the support (long) and
 *  end-cap (short) assignment the rung-2 construction needs. */
function edgeRows(
  occ: OccModule,
  scope: DisposeScope,
  faces: OccShape[],
  ring: OccShape[],
  kindOf: (edge: OccShape) => string,
): string[] {
  const rows: string[] = []
  for (const face of faces) {
    for (const edge of canonicalEdges(occ, scope, face) as OccShape[]) {
      let neighbour = 'none'
      for (const other of ring) {
        if ((canonicalEdges(occ, scope, other) as OccShape[]).some((e) => (e as OccSubShape).IsSame(edge as OccSubShape))) {
          neighbour = faceSurfaceName(occ, scope, other)
          break
        }
      }
      const curve = scope.track(new occ.BRepAdaptor_Curve_2(edge))
      const a = curve.FirstParameter()
      const b = curve.LastParameter()
      let length = 0
      let prev = scope.track(curve.Value(a))
      for (let i = 1; i <= 16; i++) {
        const next = scope.track(curve.Value(a + ((b - a) * i) / 16))
        length += Math.hypot(next.X() - prev.X(), next.Y() - prev.Y(), next.Z() - prev.Z())
        prev = next
      }
      rows.push(`${neighbour}/${kindOf(edge)}/${length.toFixed(1)}`)
    }
  }
  return rows
}

interface GroupProbe {
  group: string
  picks: string[]
  ring: string[]
  guard: string
  isDone: boolean
  isDeleted: boolean[]
  time: string
  edges: string[]
  valid: boolean
  solids: number
  volume: number
}

describe.skipIf(!oc || !solveBytes || !topologyBytes)('delete face on edge-modifier faces: step 0 probe', () => {
  if (!oc || !solveBytes || !topologyBytes) return
  const occ = oc
  const h = new SharedHarness(occ)
  let live: DisposeScope
  let shape: OccShape
  let picks: Map<string, OccShape>
  let groups: number[][]

  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSketchTopology(topologyBytes)
    const features = fixture.features as Record<string, unknown>[]
    const firstDelete = features.findIndex((f) => f.id === CHAMFER_DELETE)
    expect(firstDelete).toBeGreaterThan(0)
    const result = h.run({ features: features.slice(0, firstDelete), part_style: fixture.part_style })
    const part: PartSolid | undefined = result._build_state.checkpoints[CHAMFER_ID]?.body_store_snapshot?.[PART]
    if (!part) throw new Error('the probe document has no body after the chamfer')
    live = new DisposeScope()
    const index = makeFaceIndexCache(occ, live, h.table)(part)
    const resolved = resolveFacesByQuery(
      occ, live, h.table, part, index,
      (fixture.picks as { query: string }[]).map((p) => p.query),
    )
    picks = new Map()
    for (const p of fixture.picks as { query: string }[]) {
      const face = resolved.get(p.query)
      if (!face) throw new Error(`pick did not resolve: ${p.query}`)
      picks.set(p.query, face)
    }
    shape = h.table.get<OccShape>(part.shape!)
    groups = faceGroups(occ, live, [...picks.values()])
  })

  afterAll(() => live?.dispose())

  it('pins the measured surface classes and today\'s refusal', () => {
    const all = [...picks.values()]
    const measured: GroupProbe[] = groups.map((group) => {
      const faces = group.map((i) => all[i])
      const ring = neighbourRing(occ, live, shape, faces)
      // The raw call, so the probe measures OCC itself and not the adapter.
      const maker = live.track(new occ.BRepAlgoAPI_Defeaturing()) as OccDefeaturingMaker
      maker.SetShape(shape)
      for (const face of faces) maker.AddFaceToRemove(face)
      maker.SetToFillHistory(true)
      const t0 = Date.now()
      maker.Build(noProgress(occ))
      const millis = Date.now() - t0
      const built = live.track(maker.Shape())
      // The adapter's rung-1 guard family, read off the raw maker: guard 3's
      // IsDeleted is the only failure signal OCCT gives.
      const deleted = faces.map((f) => {
        try {
          return maker.IsDeleted(f)
        } catch {
          return false
        }
      })
      const guard = !maker.IsDone() ? 'build' : deleted.every(Boolean) ? 'none' : 'gap'
      const kindOf = classifyFaceEdges(occ, live, shape)
      return {
        group: group[0] === 0 ? 'chamfer' : 'fillet',
        picks: faces.map((f) => faceSurfaceName(occ, live, f)),
        ring: ring.map((f) => faceSurfaceName(occ, live, f)),
        guard,
        isDone: maker.IsDone(),
        isDeleted: deleted,
        time: millis < 2000 ? '< 2 s' : `>= 2 s (${millis} ms)`,
        edges: edgeRows(occ, live, faces, ring, (e) => kindOf(e)),
        valid: isValidShape(occ, live, built),
        solids: exploreSolids(occ, live, built).length,
        volume: volumeOf(occ, live, built),
      }
    })
    console.log(JSON.stringify(measured, null, 2))
    expect(measured).toEqual([
      {
        group: 'chamfer',
        picks: ['BSplineSurface'],
        ring: ['Plane', 'Sphere', 'Plane'],
        guard: 'gap',
        isDone: true,
        isDeleted: [false],
        time: '< 2 s',
        edges: [
          'Plane/concave/3.3',
          'Sphere/convex/46.9',
          'Plane/convex/41.6',
          'Plane/concave/3.3',
        ],
        valid: true,
        solids: 1,
        volume: 55816.29196819374,
      },
      {
        group: 'fillet',
        picks: ['BSplineSurface'],
        ring: ['Plane', 'Sphere', 'Plane'],
        guard: 'gap',
        isDone: true,
        isDeleted: [false],
        time: '< 2 s',
        edges: [
          'Plane/concave/7.1',
          'Sphere/tangent/42.4',
          'Plane/tangent/34.5',
          'Plane/concave/7.1',
        ],
        valid: true,
        solids: 1,
        volume: 55816.29196819374,
      },
    ])
  }, 300_000)
})
