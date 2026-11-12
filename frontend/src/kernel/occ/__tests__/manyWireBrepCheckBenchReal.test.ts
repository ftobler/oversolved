// @vitest-environment node
//
// Part D's measured gate: what does one whole-body BRepCheck_Analyzer cost on
// the many-hole plate, and where does the time go? R2 expects BRepCheck_Face's
// pairwise wire checks on the two planar faces that carry every hole as an
// inner wire, so the same analyzer is also run face by face to show the split.
//
// Log-only on purpose, like bundleRebuildCostBenchReal.test.ts: a wall-clock
// threshold in the suite would flake on a contended box. The gate is read from
// the log and recorded in feature/knowledgebase.history.md. Opt-in, so a normal
// `just frontend` pays nothing:
//
//   cd frontend && BREP_CHECK_BENCH=1 npx vitest run src/kernel/occ/__tests__/manyWireBrepCheckBenchReal.test.ts
//
// The subject is the build123d fast_grid_holes plate: 500 x 600 x 1, hex
// through-holes of circumradius 9, in one batch cut.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { HandleTable } from '../handleTable'
import { buildExtrudedProfile } from '../shapes'
import { makeBox } from '../primitives'
import { canonicalizeCylinderFaces } from '../canonicalSurfaces'
import {
  booleanWithHistoryMany,
  cleanWithHistory,
  composeDiffThroughClean,
  composeOriginThroughClean,
  shapeIsValid,
} from '../booleans'
import type { OccModule, OccShape } from '../occTypes'
import type { Vec3 } from '../primitives'

const enabled = !!process.env.BREP_CHECK_BENCH
const oc = enabled ? await loadOcc() : null

const PLATE = { x: 500, y: 600, z: 1 }
const HEX_RADIUS = 9
const HEX_PITCH_X = 34.64101615137755
const HEX_PITCH_Y = 20
// Vertex-on-x hexagon: (3 sqrt 3 / 2) r^2.
const HEX_VOLUME = (3 * Math.sqrt(3) / 2) * HEX_RADIUS * HEX_RADIUS

/** One tool per hole, in the source's staggered 25-column honeycomb layout. */
function hexTools(occ: OccModule, table: HandleTable, count: number): OccShape[] {
  const tools: OccShape[] = []
  for (let i = 0; i < count; i++) {
    const col = i % 25
    const row = Math.floor(i / 25)
    const cx = 20 + col * (HEX_PITCH_X / 2)
    const cy = 20 + row * HEX_PITCH_Y + (col % 2 === 1 ? HEX_PITCH_Y / 2 : 0)
    const loop: Vec3[] = Array.from({ length: 6 }, (_, k) => {
      const a = (Math.PI / 3) * k
      return [cx + HEX_RADIUS * Math.cos(a), cy + HEX_RADIUS * Math.sin(a), -0.5] as Vec3
    })
    tools.push(table.get<OccShape>(buildExtrudedProfile(occ, table, {
      loop, direction: [0, 0, 1], distance: 2,
    })))
  }
  return tools
}

function countWires(occ: OccModule, face: OccShape): number {
  const exp = new occ.TopExp_Explorer_2(
    face, occ.TopAbs_ShapeEnum.TopAbs_WIRE, occ.TopAbs_ShapeEnum.TopAbs_SHAPE,
  )
  try {
    let count = 0
    for (; exp.More(); exp.Next()) count++
    return count
  } finally {
    exp.delete()
  }
}

function exploreFaces(occ: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const exp = scope.track(new occ.TopExp_Explorer_2(
    shape, occ.TopAbs_ShapeEnum.TopAbs_FACE, occ.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ))
  const faces: OccShape[] = []
  for (; exp.More(); exp.Next()) faces.push(scope.track(exp.Current() as OccShape))
  return faces
}

function timed<T>(label: string, run: () => T): { value: T; ms: number } {
  const t0 = performance.now()
  const value = run()
  const ms = performance.now() - t0
  console.log(`  ${label.padEnd(52)} ${ms.toFixed(0).padStart(7)} ms`)
  return { value, ms }
}

function measure<T>(run: () => T): { value: T; ms: number } {
  const t0 = performance.now()
  const value = run()
  return { value, ms: performance.now() - t0 }
}

describe.runIf(enabled)('many-wire BRepCheck bench provisioning', () => {
  it('has OCC.js when BREP_CHECK_BENCH is set', () => {
    expect(oc, 'BREP_CHECK_BENCH=1 but OCC.js is absent - run `npm run occ:install`').toBeTruthy()
  })
})

describe.skipIf(!oc || !enabled)('many-wire BRepCheck cost (real OCC, log-only)', () => {
  for (const holes of [130, 325, 625]) {
    it(`a ${holes}-hole plate: boolean phases, one whole-body check, and the per-face split`, () => {
      if (!oc) throw new Error('unreachable: skipIf guards this')
      const occ = oc
      const scope = new DisposeScope()
      const table = new HandleTable()
      try {
        console.log(`\n[${holes} hex through-holes in a ${PLATE.x} x ${PLATE.y} x ${PLATE.z} plate]`)
        const plate = scope.track(makeBox(occ, scope, PLATE.x, PLATE.y, PLATE.z))
        const tools = hexTools(occ, table, holes)
        const raw = timed('raw multi-tool cut', () =>
          booleanWithHistoryMany(occ, scope, plate, tools, 'cut')).value
        scope.track(raw.shape)
        const canonical = timed('cylinder canonicalization', () =>
          canonicalizeCylinderFaces(occ, scope, raw.shape)).value
        if (canonical.changed) scope.track(canonical.shape)
        const clean = timed('clean (UnifySameDomain)', () =>
          cleanWithHistory(occ, scope, canonical.shape)).value
        scope.track(clean.shape)
        const diff = timed('compose diff through clean', () =>
          composeDiffThroughClean(occ, scope, raw.diff, clean.history, clean.shape)).value
        const origin = timed('compose origin through clean', () =>
          composeOriginThroughClean(occ, scope, raw.faceOrigin, clean.history, clean.shape)).value
        console.log(`  ${'diff/output lists'.padEnd(52)} ${String(diff.new_faces.length + diff.inherited_faces.length).padStart(7)} faces, ${String(diff.new_edges.length + diff.inherited_edges.length).padStart(7)} edges, ${origin.length} origins`)

        const valid = timed('whole-body BRepCheck_Analyzer', () =>
          shapeIsValid(occ, scope, clean.shape))
        const faces = exploreFaces(occ, scope, clean.shape)
        const wires = faces.map((f) => countWires(occ, f))
        const perFace = faces.map((face) => measure(() => shapeIsValid(occ, scope, face)).ms)
        const faceSum = perFace.reduce((a, b) => a + b, 0)
        const slowest = faces
          .map((_, i) => i)
          .sort((a, b) => perFace[b] - perFace[a])
          .slice(0, 4)
        console.log(`  ${'per-face check: sum over all faces'.padEnd(52)} ${faceSum.toFixed(0).padStart(7)} ms`)
        for (const i of slowest) {
          console.log(`  face ${String(i).padStart(3)}: ${String(wires[i]).padStart(4)} wires, ${perFace[i].toFixed(0).padStart(7)} ms`)
        }

        // The geometric contract only: the bench measures time, it does not
        // assert it.
        expect(valid.value).toBe(true)
        expect(faces.filter((_, i) => wires[i] > 1).length).toBe(2)
        expect(Math.abs(volumeOfPlate(occ, scope, clean.shape) - (PLATE.x * PLATE.y * PLATE.z - holes * HEX_VOLUME)))
          .toBeLessThan(1e-6 * PLATE.x * PLATE.y * PLATE.z)
      } finally {
        table.disposeAll()
        scope.dispose()
      }
    }, 1_800_000)
  }
})

function volumeOfPlate(occ: OccModule, scope: DisposeScope, shape: OccShape): number {
  const props = scope.track(new occ.GProp_GProps_1())
  occ.BRepGProp.VolumeProperties_2(shape, props, 1e-9, true, false)
  return props.Mass()
}
