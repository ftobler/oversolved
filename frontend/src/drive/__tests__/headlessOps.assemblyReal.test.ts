// @vitest-environment node
//
// compareAssemblyHeadless against a hand reference: the pin-on-plate assembly
// measures 61570.8 mm3 in a 100 x 60 x 30 box, and a reference perturbed by 1 %
// fails only the volume row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { PartDoc } from '@/types/cad'
import type { TranslationReference } from '@/translations/corpus'
import { compareAssemblyHeadless, runAssemblyHeadless } from '../headlessOps'
import { emptyDriveAssemblyDoc, setMateSolver, type AssemblyScriptStep } from '../headlessAssembly'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, plane: '@builtin_plane_front',
    entities: [{ id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const }, { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const }],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
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

function extrude(sketchId: string, id: string, distance: number) {
  return { id, kind: 'extrude', extrude: { sketch: `$${sketchId}`, distance, direction: 'normal', operation: 'new' } }
}

const plate = (): PartDoc => ({
  version: 1, kind: 'part',
  features: [rectSketch('sk1', 100, 60), extrude('sk1', 'ex1', 10)],
}) as unknown as PartDoc

const pin = (): PartDoc => ({
  version: 1, kind: 'part',
  features: [
    { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [{ id: 'c1', kind: 'circle' }], initial: { c1: [0, 0, 5] } },
    extrude('sk1', 'ex1', 20),
  ],
}) as unknown as PartDoc

const FLAT = (axis: [number, number, number], side: 'min' | 'max') => ({
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' }, { extreme: { axis, side } }] },
})

const STEPS: AssemblyScriptStep[] = [
  { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
  { mutation: { type: 'add_part', handle: 'pin', part: 'pin', position: [30, 30, 40] } },
  { mutation: {
    type: 'add_mate', featureId: 'm1', kind: 'fixed',
    ref_a: { part: 'plate', selector: FLAT([0, 0, 1], 'max') },
    ref_b: { part: 'pin', selector: FLAT([0, 0, 1], 'min') },
    flip: true,
  } },
]

const PARTS = new Map([['plate', plate()], ['pin', pin()]])

const PIN_VOLUME = Math.PI * 25 * 20
const TOTAL_VOLUME = 6000 * 10 + PIN_VOLUME
const PIN_AREA = Math.PI * 25 * 2 + Math.PI * 5 * 2 * 20
const PLATE_AREA = 2 * 6000 + 2 * 100 * 10 + 2 * 60 * 10

function reference(volume: number): TranslationReference {
  return {
    source: { tool: 'hand', version: '1', file: '-' },
    tolerance: { rel: 1e-4, abs: 0.01 },
    topology: 'report',
    bodies: 2,
    volume,
    area: PLATE_AREA + PIN_AREA,
    centroid: [50, 30, (6000 * 10 * 5 + PIN_VOLUME * 20) / TOTAL_VOLUME],
    bbox: [0, 0, 0, 100, 60, 30],
  }
}

describeReal('compareAssemblyHeadless', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
    setMateSolver(solveMate)
  })
  afterAll(() => {
    setMateSolver(null)
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('passes the pin-on-plate reference', async () => {
    const doc = (await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: PARTS, steps: STEPS })).doc
    const compared = await compareAssemblyHeadless(doc, PARTS, reference(TOTAL_VOLUME))
    expect(compared.ok).toBe(true)
    expect(compared.pass).toBe(true)
    expect(compared.rows.every(row => row.within)).toBe(true)
    expect(compared.measures!.bodies).toBe(2)
    expect(compared.measures!.volume).toBeCloseTo(TOTAL_VOLUME, 4)
  }, 180_000)

  it('fails only the volume row for a reference 1 % off', async () => {
    const doc = (await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: PARTS, steps: STEPS })).doc
    const compared = await compareAssemblyHeadless(doc, PARTS, reference(TOTAL_VOLUME * 1.01))
    expect(compared.ok).toBe(true)
    expect(compared.pass).toBe(false)
    expect(compared.rows.find(row => row.measure === 'volume')).toMatchObject({ within: false })
    expect(compared.rows.filter(row => row.measure !== 'volume').every(row => row.within)).toBe(true)
  }, 180_000)
})
