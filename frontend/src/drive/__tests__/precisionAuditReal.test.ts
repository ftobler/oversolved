// @vitest-environment node
//
// The precision audit's permanent probes (feature/precision-audit-near-coaxial):
// the solver write-back reaching the document grid, the near-coaxial fuse band
// the add/boolean warning names, and the fillet's near-tangent-corner message.
// Synthetic numbers only. Real OCC + Rust wasm, gated like the drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, emptyDriveDoc, selectHeadless } from '../headlessOps'
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

const onGrid = (v: number): boolean => Math.abs(v * 1e6 - Math.round(v * 1e6)) < 1e-6

describe.skipIf(!ready)('precision audit probes (real OCC + Rust solver)', () => {
  it('a driven seed off by 5e-6 is baked to the document grid, not kept', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', label: 'Driven', plane: '@builtin_plane_front' }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 10.000005, 0], entityId: 'l1' }),
        m({ type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:l1'] }),
        m({ type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 10 }),
      ],
      docId: 'precision-writeback',
    })
    expect(result.ok).toBe(true)
    const stored = sketchOf(result.doc as PartDoc, 'sk1').initial!.l1
    // The retired 1e-6-relative envelope would have kept 10.000005 (1e-5
    // absolute here); the solver's moved report hands the write-back a new
    // spelling instead.
    expect(stored[2]).not.toBe(10.000005)
    expect(onGrid(stored[0])).toBe(true)
    expect(onGrid(stored[2])).toBe(true)
    // Two independently rounded coordinates form the dimension, so it can read
    // one grid step off the authored value. That is the storage grid.
    expect(Math.abs(stored[2] - stored[0] - 10)).toBeLessThanOrEqual(1e-6)
  }, 120_000)

  it.each([0, 0.5, 1, 2, 5, 10, 100, 10000])(
    'the near-coaxial add at k=%s warns exactly in the hazard band',
    async (k) => {
      const delta = k * 1e-6
      const result = await runHeadless({
        doc: emptyDriveDoc(),
        steps: [
          m({ type: 'add_sketch', featureId: 'skb', label: 'Base', plane: '@builtin_plane_front' }),
          m({ type: 'add_entity', featureId: 'skb', kind: 'circle', params: [0, 0, 10], entityId: 'cb' }),
          m({ type: 'add_extrude', featureId: 'exb', label: 'Base', sketchQuery: '$skb', distance: 10, operation: 'new' }),
          m({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 10 } }),
          m({ type: 'add_sketch', featureId: 'skt', label: 'Top', plane: '@pl1' }),
          m({ type: 'add_entity', featureId: 'skt', kind: 'circle', params: [0, 0, 10 + delta], entityId: 'ct' }),
          m({ type: 'add_extrude', featureId: 'ext', label: 'Top', sketchQuery: '$skt', distance: 10, operation: 'add' }),
        ],
        docId: `precision-near-coaxial-${k}`,
      })
      expect(result.ok).toBe(true)
      const doc = result.doc as PartDoc
      const cylinders = (await selectHeadless(doc, { kind: 'face', where: { type: 'cylinderface' } }))!.items
      const storedDelta = Math.round(delta * 1e6) / 1e6
      if (k === 0) {
        // Exact coaxial: one lateral face, no shoulder to fillet.
        expect(cylinders).toHaveLength(1)
        expect(nonSketchProblems(result.features)).toEqual([])
        return
      }
      // Any representable difference keeps two faces, even one grid step.
      expect(cylinders).toHaveLength(2)
      const radii = cylinders.map(face => (face.geometry as { radius: number }).radius).sort((a, b) => a - b)
      expect(radii[0]).toBeCloseTo(10, 9)
      expect(radii[1]).toBeCloseTo(10 + storedDelta, 9)

      const warning = result.features.find(problem => problem.id === 'ext')
      // The band's top edge is 1e-4 x r = 1e-3; k=10000 (1e-2) is a visible
      // step the user authored and must not be flagged.
      if (storedDelta <= 1e-4 * (10 + storedDelta)) {
        expect(warning?.status).toBe('ok')
        expect(warning?.message).toContain('near-coaxial cylinder faces')
        expect(warning?.message).toContain('were not merged')
      } else {
        expect(warning).toBeUndefined()
      }

      // The junction between the two faces refuses a fillet at r 1 at every
      // near-coaxial delta; the warning is what makes that refusal legible.
      const junction = await selectHeadless(doc, {
        kind: 'edge',
        where: { and: [{ type: 'circle' }, { within: { axis: 'z', min: 10, max: 10 } }, { convexity: 'concave' }] },
      })
      expect(junction!.queries.length).toBeGreaterThan(0)
      const filleted = await runHeadless({
        doc,
        steps: [m({ type: 'add_fillet', featureId: 'fi1', edges: junction!.queries, radius: 1 })],
        docId: `precision-near-coaxial-fillet-${k}`,
      })
      const filletProblem = filleted.features.find(problem => problem.id === 'fi1')
      if (storedDelta <= 1e-4 * (10 + storedDelta)) {
        expect(filletProblem?.status).toBe('exception')
      }
    },
    120_000,
  )

  it('a near-tangent corner is named instead of the bare kernel refusal', async () => {
    // A circle with a chord 0.5 mrad off tangent: the extruded body's two
    // vertical corners are true near-tangencies (0.0286 degrees).
    const radius = 10
    const alpha = 0.0005
    const c = radius * Math.sin(alpha)
    const d = radius * Math.cos(alpha)
    const alphaDeg = (alpha * 180) / Math.PI
    const base = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 0, radius, 90 + alphaDeg, 450 - alphaDeg], entityId: 'major' }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [c, d, -c, d], entityId: 'chord' }),
        m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' }),
      ],
      docId: 'precision-near-tangent-base',
    })
    expect(nonSketchProblems(base.features)).toEqual([])
    const doc = base.doc as PartDoc
    const verticals = (await selectHeadless(doc, { kind: 'edge', where: { parallel: [0, 0, 1] } }))!.queries
    expect(verticals).toHaveLength(2)

    // Below the 0.01 chord-wide face's half width, so the width diagnosis does
    // not fire and the message has to come from the near-tangent corner.
    const filleted = await runHeadless({
      doc,
      steps: [m({ type: 'add_fillet', featureId: 'fi1', edges: verticals.slice(0, 1), radius: 0.001 })],
      docId: 'precision-near-tangent-fillet',
    })
    const problem = filleted.features.find(row => row.id === 'fi1')
    expect(problem?.status).toBe('exception')
    expect(problem?.message).toContain('near-tangent corner')
    expect(problem?.message).toContain('0.0286 deg')
    expect(problem?.message).not.toContain('no reason from the kernel')
  }, 120_000)
})
