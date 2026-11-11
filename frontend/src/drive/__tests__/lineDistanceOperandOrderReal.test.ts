// @vitest-environment node
//
// The Ex002 bug rebuilt from the finding text: an 80 x 60 x 10 block with a
// 22 mm through hole. The hole sketch carries a circle, its diameter, and two
// point-first `line_distance` dimensions to projected top edges. Point-first
// used to be accepted, stored and silently dropped by the solver, leaving the
// centre free. The authoring layer now stores the line first, the solve reports
// the centre at the face centre, and a genuinely unreadable constraint is a
// sketch warning in the run reply instead of a silent absence.
//
// Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import type { EdgeGeometry } from '@/kernel/select'
import { runHeadless, emptyDriveDoc, selectHeadless, exportHeadless } from '../headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'
import type { ScriptStep } from '../scriptRunner'

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

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

function sketchOf(doc: PartDoc, id: string): SketchFeature {
  return (doc.features ?? []).find(f => f.id === id) as SketchFeature
}

const BOX: ScriptStep[] = [
  m({ type: 'add_sketch', featureId: 'sk1', label: 'Block', plane: '@builtin_plane_top' }),
  m({
    type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [40, 30],
    centerRef: '@builtin_origin', dimensions: true,
    entityIds: ['bottom', 'right', 'top', 'left', 'centre'],
  }),
  m({ type: 'add_extrude', featureId: 'ex1', label: 'Block', sketchQuery: '$sk1', distance: 10, direction: 'symmetric', operation: 'new' }),
]

/** The signed side of `point` against a sketch-local line's own direction,
 *  matching the solver's perpendicular normal. */
function lineDistanceSign(params: readonly number[], point: readonly [number, number]): { value: number; sign: number } {
  const [sx, sy, ex, ey] = params
  const dx = ex - sx
  const dy = ey - sy
  const n = Math.hypot(dx, dy)
  const t = (point[0] - sx) * (-dy / n) + (point[1] - sy) * (dx / n)
  return { value: Math.abs(t), sign: t < 0 ? -1 : 1 }
}

describe.skipIf(!ready)('line_distance operand order (real OCC + Rust solver)', () => {
  it('fully constrains the Ex002 hole sketch from point-first dimensions', async () => {
    const box = await runHeadless({ doc: emptyDriveDoc(), steps: BOX })
    expect(box.ok).toBe(true)
    expect(nonSketchProblems(box.features)).toEqual([])

    // The Top builtin plane's normal is +Y (Y is up), so the block's top face
    // is the +Y extreme.
    const topFace = {
      kind: 'face' as const,
      where: { and: [{ type: 'flatface' }, { parallel: [0, 1, 0] }, { extreme: { axis: [0, 1, 0], side: 'max' as const } }] },
    }
    const topEdges = (await selectHeadless(box.doc as PartDoc, { kind: 'edge', where: { on_face: topFace } }))!
    const lines = topEdges.items.filter(item => {
      const g = item.geometry as EdgeGeometry
      return g.start !== undefined && g.end !== undefined
    })
    const alongX = lines.filter(item => {
      const g = item.geometry as EdgeGeometry
      return Math.abs(g.end![2] - g.start![2]) < 1e-9 && g.start![2] > 0
    })
    const alongZ = lines.filter(item => {
      const g = item.geometry as EdgeGeometry
      return Math.abs(g.end![0] - g.start![0]) < 1e-9 && g.start![0] > 0
    })
    expect(alongX).toHaveLength(1)
    expect(alongZ).toHaveLength(1)

    const faceQuery = (await selectHeadless(box.doc as PartDoc, topFace))!.queries[0]
    const projected = await runHeadless({
      doc: box.doc as PartDoc,
      steps: [
        m({ type: 'add_sketch', featureId: 'sk2', label: 'Hole site', plane: faceQuery }),
        m({ type: 'add_projected_entity', featureId: 'sk2', kind: 'line', source: alongX[0].query, entityId: 'px' }),
        m({ type: 'add_projected_entity', featureId: 'sk2', kind: 'line', source: alongZ[0].query, entityId: 'pz' }),
      ],
    })
    expect(projected.ok).toBe(true)
    // The projected lines' SOLVED params are the sketch-local 2D endpoints:
    // the values and signs the authoring gesture would read.
    const sketchAfterProjection = sketchOf(projected.doc as PartDoc, 'sk2')
    const toX = lineDistanceSign(sketchAfterProjection.initial!.px, [0, 0])
    const toZ = lineDistanceSign(sketchAfterProjection.initial!.pz, [0, 0])
    expect(toX.value).toBeCloseTo(30, 6)
    expect(toZ.value).toBeCloseTo(40, 6)

    const steps: ScriptStep[] = [
      m({ type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [0, 0, 11], entityId: 'c1' }),
      m({ type: 'add_constraint', featureId: 'sk2', kind: 'diameter', targets: ['entity:sk2:c1'], value: 22 }),
      // Point first: the order a mixed click can produce, and the one the
      // finding reported as inert.
      m({
        type: 'add_constraint', featureId: 'sk2', kind: 'line_distance',
        targets: ['vertex:sk2:c1:center', 'entity:sk2:px'], value: toX.value, sign: toX.sign,
      }),
      m({
        type: 'add_constraint', featureId: 'sk2', kind: 'line_distance',
        targets: ['vertex:sk2:c1:center', 'entity:sk2:pz'], value: toZ.value, sign: toZ.sign,
      }),
    ]

    const hole = await runHeadless({ doc: projected.doc as PartDoc, steps })
    expect(hole.ok).toBe(true)
    // Fully constrained: no warning row, no free centre.
    expect(hole.features).toEqual([])
    const doc = hole.doc as PartDoc
    const stored = sketchOf(doc, 'sk2').constraints ?? []
    const dimensions = stored.filter(c => c.kind === 'line_distance')
    expect(dimensions).toHaveLength(2)
    // The drive applier stored the line side in `a`, the form the solver reads.
    for (const c of dimensions) {
      expect(c.a).toMatch(/^\$p[xz]$/)
      expect(c.b).toBe('$c1center')
    }
    const centre = sketchOf(doc, 'sk2').initial!.c1
    expect(centre[0]).toBeCloseTo(0, 6)
    expect(centre[1]).toBeCloseTo(0, 6)
    // A hole site with no extrude is a valid sketch: the measurement is the
    // drawable body the block alone still builds.
    expect(doc.features?.some(f => f.id === 'ex1')).toBe(true)
  }, 120_000)

  it('reports a stale ref and still exports the otherwise complete part', async () => {
    const built = await runHeadless({ doc: emptyDriveDoc(), steps: BOX })
    expect(built.ok).toBe(true)
    const doc = built.doc as PartDoc
    const added = await runHeadless({
      doc,
      steps: [
        m({ type: 'add_sketch', featureId: 'sk2', label: 'Hole', plane: '@builtin_plane_front' }),
        m({ type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [0, 0, 5], entityId: 'c1' }),
        m({ type: 'add_constraint', featureId: 'sk2', kind: 'diameter', targets: ['entity:sk2:c1'], value: 10 }),
        m({ type: 'add_constraint', featureId: 'sk2', kind: 'coincident', targets: ['vertex:sk2:c1:center', '@builtin_origin'] }),
      ],
    })
    expect(added.ok).toBe(true)
    // A ref the sketch no longer has: partDocToSketches drops it before the
    // wire, so the warning has to come from the lowering side.
    sketchOf(added.doc as PartDoc, 'sk2').constraints!.push({
      id: 'c_missing', kind: 'coincident', a: '$ghost', b: '$c1center',
    })
    const result = await runHeadless({ doc: added.doc as PartDoc, steps: [] })
    expect(result.ok).toBe(true)
    const problem = result.features.find(feature => feature.id === 'sk2')
    expect(problem).toBeDefined()
    expect(problem!.status).toBe('fully_constrained')
    expect(problem!.message).toContain('constraint c_missing (coincident) names operands it cannot use (stale reference) and was ignored')

    // A build warning on a complete sketch is not an export failure.
    const exported = await exportHeadless(result.doc as PartDoc, { format: 'step' })
    expect(exported!.ok).toBe(true)
    expect(exported!.bytes!.byteLength).toBeGreaterThan(0)
  }, 120_000)

  it('reports an unreadable constraint as a sketch warning instead of hiding it', async () => {
    // A Length on a circle centre: well-formed refs, no slot the length
    // builder can read. The sketch is otherwise fully constrained, so the
    // warning cannot be confused with the underconstrained message.
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', label: 'Hole', plane: '@builtin_plane_front' }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 11], entityId: 'c1' }),
        m({ type: 'add_constraint', featureId: 'sk1', kind: 'diameter', targets: ['entity:sk1:c1'], value: 22 }),
        m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:c1:center', '@builtin_origin'] }),
        m({ type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['vertex:sk1:c1:center'], value: 3 }),
      ],
    })
    expect(result.ok).toBe(true)
    const problem = result.features.find(feature => feature.id === 'sk1')
    expect(problem).toBeDefined()
    expect(problem!.status).toBe('fully_constrained')
    expect(problem!.message).toMatch(
      /^constraint c_length_\S+ \(length\) names operands it cannot use \(operand kind\) and was ignored\.$/,
    )
  }, 120_000)
})
