// @vitest-environment node
//
// The cosmetic thread end to end: a document with a tapped hole, solved by the
// real kernel the way the app solves it, must hand the viewport's own functions
// (collectThreadSites, tappedFaces, buildThreadAttributes) a non-empty result
// on the drilled body. Every unit test of one link passed while the app showed
// nothing, so this pins the whole chain on the user's repro part: a 40 x 40 x 25
// plate, M6x1, 5 mm bore blind 20, tapped 15.
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { Mesh3D, PartDoc, SketchData } from '@/types/cad'
import { runHeadless, seedBuiltins } from '@/drive/headlessOps'
import { partSolvePayload } from '@/drive/solveWriteBack'
import type { ScriptStep } from '@/drive/scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader, solveLocally } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { buildThreadAttributes, collectThreadSites, tappedFaces } from '../threadShading'

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

const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation }) as ScriptStep

const STEPS: ScriptStep[] = [
  step({ type: 'add_sketch', featureId: 'sk_plate', plane: '@builtin_plane_top' }),
  step({ type: 'add_rect', featureId: 'sk_plate', p0: [0, 0], p1: [40, 40] }),
  step({ type: 'add_extrude', featureId: 'ex_plate', sketchQuery: '$sk_plate', distance: 25, operation: 'new' }),
  step({ type: 'add_sketch', featureId: 'sk_hole', plane: '@builtin_plane_top' }),
  step({ type: 'add_entity', featureId: 'sk_hole', kind: 'point', params: [20, 20] }),
  step({
    type: 'add_hole', featureId: 'ho1', sketch: '@sk_hole', diameter: 5, depth_mode: 'blind', depth: 20,
    direction: 'normal', thread: { designation: 'M6x1', nominal: 6, pitch: 1 }, thread_depth: 15,
  }),
]

describe.skipIf(!ready)('cosmetic thread shading through the real solve (real OCC)', () => {
  it('reaches the drilled body as tapped faces and per-vertex attributes', async () => {
    const run = await runHeadless({ doc: seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc), steps: STEPS })
    expect(run.ok, JSON.stringify(run.features)).toBe(true)
    const doc = run.doc!
    const payload = partSolvePayload(doc, 'probe')
    const response = await solveLocally(payload, { rollbackPosition: payload.rollback_position })
    expect(response).not.toBeNull()

    const results = response!.result as Record<string, SketchData>
    const thread = results.ho1?.thread
    expect(thread, JSON.stringify(results.ho1)).toBeDefined()
    expect(thread!.sites).toHaveLength(1)
    expect(thread!.sites[0].length).toBeCloseTo(15, 6)

    const sites = collectThreadSites(doc.features as { id: string; kind?: string }[], results, 'mm')
    expect(sites, 'collectThreadSites').not.toBeNull()

    const bodies = Object.values(response!.bodies) as { mesh?: Mesh3D }[]
    const meshes = bodies.map(b => b.mesh).filter((m): m is Mesh3D => m !== undefined)
    expect(meshes.length).toBeGreaterThan(0)
    // Name what the mesh carries if the match fails, so the broken link shows.
    const cylinders = meshes.flatMap(m => (m.face_data ?? [])
      .map((d, i) => ({ type: d.surface_type, query: m.face_queries?.[i] }))
      .filter(f => f.type === 'cylinderface'))
    const tapped = meshes.map(m => tappedFaces(m, sites))
    expect(tapped.some(t => t !== null), JSON.stringify({ uuids: [...sites!.keys()], cylinders })).toBe(true)
    const attrs = meshes.map(m => buildThreadAttributes(m, sites)).find(a => a !== null)
    expect(attrs).toBeDefined()
    // Some vertex is inside the tapped run.
    let inside = 0
    for (let v = 0; v < attrs!.coord.length / 4; v++) {
      const s = attrs!.coord[v * 4 + 2]
      const sMax = attrs!.coord[v * 4 + 3]
      if (sMax > 0 && s >= 0 && s <= sMax) inside++
    }
    expect(inside).toBeGreaterThan(0)
  })
})
