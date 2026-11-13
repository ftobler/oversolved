// @vitest-environment node
//
// A projected entity's kind follows its source every solve. This is the
// real-kernel half of the re-validation rule: a constraint the target's CURRENT
// kind cannot take is dropped with a `dropped_constraints` record and named in
// the sketch warning, while the document row stays put so the kind round trip
// re-enables it. Rebuilt from scratch (not from the practice example): a source
// arc or circle on Top, a target sketch on Top that holds the projection, and a
// target plane tilted about world x (ellipse) or y (edge-on silhouette).
//
// Skips when OCC.js or the Rust solver is absent.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, emptyDriveDoc } from '@/drive/headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '@/drive/scriptRunner'

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

/** A step carrying mutation fields the drive accepts but the Mutation union
 *  does not spell (a plane definition). */
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

const TOP = '@builtin_plane_top'

/** A plane through the world origin swung `deg` about a world axis. The bug's
 *  target plane was a tilted child of Top; the kind change is the same. The
 *  builtin Top frame's normal is world +Y, so a swing about x by 90 leaves the
 *  source circle parallel (anti-normal) rather than edge-on: the edge-on swing
 *  is about y, whose normal keeps no y component. */
function tiltedPlane(featureId: string, deg: number, axis: 'x' | 'y' = 'x'): Record<string, unknown> {
  return {
    type: 'add_plane', featureId, label: `Tilt ${deg}`,
    definition: { mode: 'origin_rotation', origin: [0, 0, 0], rotation_axis: axis, rotation_angle: deg },
  }
}

function sketchOf(doc: PartDoc | null, id: string): SketchFeature | undefined {
  const feature = doc?.features?.find(candidate => candidate.id === id)
  return feature?.kind === 'sketch' ? feature : undefined
}

const kindOf = (doc: PartDoc | null, sketchId: string, entityId: string): string | undefined =>
  sketchOf(doc, sketchId)?.entities?.find(entity => entity.id === entityId)?.kind

const paramsOf = (doc: PartDoc | null, sketchId: string, entityId: string): number[] | undefined =>
  sketchOf(doc, sketchId)?.initial?.[entityId]

/** The base documents: a source sketch on Top, a target sketch on Top with the
 *  projection and the constraints, plus the tilted planes to move the target to.
 *  Coplanar at first, so the projection resolves as the source's own kind. */
function targetOnTop(kind: 'arc' | 'circle'): ReturnType<typeof runHeadless> {
  const sourceEntity = kind === 'arc'
    ? { type: 'add_entity', featureId: 'skSrc', kind: 'arc', params: [5, 10, 4, 0, 120], entityId: 'e0' }
    : { type: 'add_entity', featureId: 'skSrc', kind: 'circle', params: [5, 10, 3], entityId: 'e0' }
  const constraints: Record<string, unknown>[] = kind === 'arc'
    ? [
        {
          type: 'add_constraint', featureId: 'skT', kind: 'coincident',
          targets: ['vertex:skT:pt:xy', 'vertex:skT:pa0:center'],
        },
      ]
    : [
        {
          type: 'add_constraint', featureId: 'skT', kind: 'coincident',
          targets: ['vertex:skT:pt:xy', 'vertex:skT:pa0:center'],
        },
        {
          type: 'add_constraint', featureId: 'skT', kind: 'equal_length',
          targets: ['entity:skT:pa0', 'entity:skT:uc'],
        },
        {
          type: 'add_constraint', featureId: 'skT', kind: 'diameter',
          targets: ['entity:skT:pa0'], value: 6,
        },
      ]
  const steps = [
    { type: 'add_sketch', featureId: 'skSrc', label: 'Source', plane: TOP },
    sourceEntity,
    // A plane must precede the sketch that names it, so the tilted planes are
    // authored before the target can move onto one.
    tiltedPlane('pl30', 30),
    tiltedPlane('plEdge', 90, 'y'),
    { type: 'add_sketch', featureId: 'skT', label: 'Target', plane: TOP },
    { type: 'add_projected_entity', featureId: 'skT', kind, source: '@skSrc/e0', entityId: 'pa0' },
    { type: 'add_entity', featureId: 'skT', kind: 'point', params: [10, 12], entityId: 'pt' },
    ...(kind === 'circle'
      ? [{ type: 'add_entity', featureId: 'skT', kind: 'circle', params: [0, 0, 2], entityId: 'uc' }]
      : []),
    ...constraints,
  ].map(step)
  return runHeadless({ doc: emptyDriveDoc(), steps, frames: 'all' })
}

/** Move the target sketch to another plane; the projection re-resolves and the
 *  lowering re-judges the rows against the new kind. */
function moveTarget(doc: PartDoc, plane: string) {
  return runHeadless({
    doc: structuredClone(doc),
    steps: [step({ type: 'set_feature_plane', featureId: 'skT', plane })],
    featureDeltas: 'all',
    frames: 'all',
  })
}

describe.skipIf(!ready)('a resolved-kind change re-validates the constraints on it', () => {
  it('5-6. an arc that resolves to a spline drops its centre row and comes back', async () => {
    const base = await targetOnTop('arc')
    expect(base.ok).toBe(true)
    // 0 deg: the source arc is coplanar with the target, so the projection is an
    // arc, the centre row lowers and the free point is bound to the centre.
    expect(kindOf(base.doc, 'skT', 'pa0')).toBe('arc')
    expect(base.featureDeltas?.find(entry => entry.id === 'skT')?.status).toBe('fully_constrained')
    expect(paramsOf(base.doc, 'skT', 'pt')?.[0]).toBeCloseTo(5, 6)
    expect(paramsOf(base.doc, 'skT', 'pt')?.[1]).toBeCloseTo(10, 6)

    const tilted = await moveTarget(base.doc!, '@pl30')
    expect(tilted.ok).toBe(true)
    // A tilted arc has no 2D ellipse-arc entity, so it lowers to a fitted
    // spline (an eight-parameter block). The resolved kind is what the operand
    // gate sees, or the `center` key would still pass and the row would bind the
    // spline's midpoint. The baked params, not the document entity kind, are the
    // stable witness: projection-lowering-hygiene keeps the declared kind while
    // the resolved one shapes the lowering.
    expect(paramsOf(tilted.doc, 'skT', 'pa0')).toHaveLength(8)
    const row = tilted.features.find(problem => problem.id === 'skT')
    expect(row).toBeDefined()
    expect(row!.status).not.toBe('fully_constrained')
    expect(row!.message).toContain('operand center not on spline')
    // A lost centre carries the stable alternative, not only the loss.
    expect(row!.message).toContain('project the centre as a point to keep it')
    // The document keeps the row, so the round trip below can revive it.
    expect(sketchOf(tilted.doc, 'skT')?.constraints).toHaveLength(2)
    // The free point stays where the last solve left it, not on a control point
    // of the fitted spline.
    expect(paramsOf(tilted.doc, 'skT', 'pt')?.[0]).toBeCloseTo(5, 3)
    expect(paramsOf(tilted.doc, 'skT', 'pt')?.[1]).toBeCloseTo(10, 3)

    const back = await moveTarget(tilted.doc!, TOP)
    expect(back.ok).toBe(true)
    expect(kindOf(back.doc, 'skT', 'pa0')).toBe('arc')
    expect(back.featureDeltas?.find(entry => entry.id === 'skT')?.status).toBe('fully_constrained')
    expect(back.features.find(problem => problem.id === 'skT')).toBeUndefined()
    expect(paramsOf(back.doc, 'skT', 'pt')?.[0]).toBeCloseTo(5, 3)
    expect(paramsOf(back.doc, 'skT', 'pt')?.[1]).toBeCloseTo(10, 3)
  }, 240_000)

  it('7. a circle that resolves to an ellipse drops its diameter and equal rows', async () => {
    const base = await targetOnTop('circle')
    expect(base.ok).toBe(true)
    expect(kindOf(base.doc, 'skT', 'pa0')).toBe('circle')
    // The equal row pulled the user circle up to the projection's radius; it is
    // the value a silent rebind would move again.
    expect(paramsOf(base.doc, 'skT', 'uc')?.[2]).toBeCloseTo(3, 6)

    const tilted = await moveTarget(base.doc!, '@pl30')
    expect(tilted.ok).toBe(true)
    // A five-parameter conic block and the ellipse in the reasons below name the
    // resolved kind; the document entity kind is not asserted, because the
    // hygiene change keeps it declared while the solve resolves an ellipse.
    expect(paramsOf(tilted.doc, 'skT', 'pa0')).toHaveLength(5)
    const row = tilted.features.find(problem => problem.id === 'skT')
    expect(row).toBeDefined()
    expect(row!.status).not.toBe('fully_constrained')
    // Both single-target and pair kinds are re-judged: an ellipse has no
    // diameter, and it shares no radius measure with a circle.
    expect(row!.message).toContain('diameter does not apply to ellipse')
    expect(row!.message).toContain('equal_length does not apply to ellipse and circle')
    // The rows were authored while the projection was coplanar and still a
    // circle, so the add-time rule accepted them; the tilt is what made the
    // solve re-judge them. Re-authoring here is deliberately NOT asserted:
    // add time reads the kind the document declares, and the in-process solve
    // still writes the resolved kind back into the entity def. Once
    // projection-lowering-hygiene removes that write, a browser author would
    // be accepted (declared circle) and the solve would report it, exactly as
    // this test shows for the row authored before the tilt.
    expect(sketchOf(tilted.doc, 'skT')?.constraints).toHaveLength(4)
    expect(paramsOf(tilted.doc, 'skT', 'uc')).toEqual([0, 0, 3])
  }, 240_000)

  it('8. a circle seen edge-on drops the centre and equal rows, point free', async () => {
    const base = await targetOnTop('circle')
    expect(base.ok).toBe(true)
    const tilted = await moveTarget(base.doc!, '@plEdge')
    expect(tilted.ok).toBe(true)
    // The tilted target sees the source circle edge-on, so the lowering takes
    // the silhouette branch and bakes a four-parameter line block (again the
    // params, not the document entity kind, are the witness that survives the
    // hygiene change).
    expect(paramsOf(tilted.doc, 'skT', 'pa0')).toHaveLength(4)
    const row = tilted.features.find(problem => problem.id === 'skT')
    expect(row).toBeDefined()
    expect(row!.message).toContain('operand center not on line')
    expect(row!.message).toContain('equal_length does not apply to line and circle')
    // The user circle keeps the radius the equal row gave it, and the free point
    // is not dragged onto the silhouette's start.
    expect(paramsOf(tilted.doc, 'skT', 'uc')).toEqual([0, 0, 3])
    expect(paramsOf(tilted.doc, 'skT', 'pt')?.[0]).toBeCloseTo(5, 3)
    expect(paramsOf(tilted.doc, 'skT', 'pt')?.[1]).toBeCloseTo(10, 3)
  }, 240_000)
})
