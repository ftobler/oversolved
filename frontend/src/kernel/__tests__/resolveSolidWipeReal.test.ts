// `clearFeatureGeometryRegistrations` (`feature-resolve-solid-wipe`) wipes the
// `solid`/`extrusion-feature` entries a feature registered under `[@fid]` on every
// re-solve, and the body loop only re-registers solids for bodies it just created.
// This suite pins the `reconcileFeatureSolids` evict-then-register invariant that
// keeps exactly one solid + one extrusion-feature per owned body, and it
// deliberately runs the REAL `postRegister` (the checkpoint-parity suite stubs it,
// which is why it could not see the wipe). The genuinely red-green fixed bug is
// in the checkpoint pass, which used to APPEND a duplicate solid for a body the
// loop could not register (live `[@fid]` held two identical solids and
// `?@fid:solid` threw AmbiguousQueryError); the loop-side reconcile is a
// contract pin guarding the evict property.
//
// This is the real-OCC half of that pin: a SharedHarness build of a real sketch
// and extrude is re-solved after a label-only edit, so the wipe and the body
// loop run over an actual kernel checkpoint. The synthetic half, whose
// `fakeMeta` and `make`/`modify` solve isolate the evict property without OCC,
// is resolveSolidWipe.test.ts.

import { describe, it, expect, beforeAll } from 'vitest'
import { makeAncestryQuery } from '../query'
import { repoFromSnapshot } from '../builder'
import type { FeatureCheckpoint } from '../types3d'

// Imported here, not mid-file, so the dependency surface is visible at the top
// like every other kernel test; only the skipIf-gated real-OCC section uses them.
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
// ─── checkpoint snapshot introspection ───
// The ancestral key a feature's solids/extrusion live under: exactly `[@fid]`.
function featureKey(ancestral: Record<string, { set: string[]; eids: string[] }>, fid: string): string {
  const key = Object.keys(ancestral).find((k) => {
    const set = ancestral[k].set
    return set.length === 1 && set[0] === '@' + fid
  })
  if (!key) throw new Error(`no [@${fid}] ancestral entry`)
  return key
}
function elementsOfType(checkpoint: FeatureCheckpoint, fid: string, type: string): unknown[] {
  const snap = checkpoint.repo_snapshot as Record<string, unknown>
  const elements = snap.elements as Record<string, Record<string, unknown>>
  const ancestral = snap.ancestral as Record<string, { set: string[]; eids: string[] }>
  const key = featureKey(ancestral, fid)
  return ancestral[key].eids.map((eid) => elements[eid]).filter((el) => el?.type === type)
}
function resolveSolid(checkpoint: FeatureCheckpoint, fid: string): Record<string, unknown> | null {
  const repo = repoFromSnapshot(checkpoint.repo_snapshot as Record<string, unknown>)
  const el = repo.query(makeAncestryQuery(['@' + fid], 'solid'))
  return el === null ? null : (el as Record<string, unknown>)
}
// ─── real OCC: the production pipeline end to end ───
const oc = await loadOcc()
const solveBytes = loadSolver()
function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
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
describe.skipIf(!oc || !solveBytes)('real OCC: a cosmetic re-solve keeps the solid', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('editing an extrude label leaves ?@ex1:solid resolving with the solid in the checkpoint', () => {
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new', label: 'orig' }
    const r1 = h.run({ features: [sk1, ex1] })
    expect((r1.result as Record<string, Record<string, unknown>>).ex1.status).toBe('ok')
    expect(elementsOfType(r1._build_state!.checkpoints.ex1, 'ex1', 'solid')).toHaveLength(1)
    expect(resolveSolid(r1._build_state!.checkpoints.ex1, 'ex1')).not.toBeNull()

    const ex1v2 = { ...ex1, label: 'renamed' }
    const r2 = h.run({ features: [sk1, ex1v2] }, { prevState: r1._build_state })
    expect((r2.result as Record<string, Record<string, unknown>>).ex1.status).toBe('ok')
    const cp = r2._build_state!.checkpoints.ex1
    expect(elementsOfType(cp, 'ex1', 'solid')).toHaveLength(1)
    expect(elementsOfType(cp, 'ex1', 'extrusion-feature')).toHaveLength(1)
    const solid = resolveSolid(cp, 'ex1')
    expect(solid).not.toBeNull()
    expect(solid!.body_id).toBe('body_ex1')
  })
})
