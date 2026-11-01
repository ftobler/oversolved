// @vitest-environment node
//
// The named-plane table in docs/translate.md (plan mcp-practice-fixups-3 F9):
// a CadQuery/build123d rectangle u in [0, 10], v in [0, 4] extruded 3 along
// each named plane's normal, rebuilt through the table's Oversolved plane,
// sketch swap and direction, lands on the bbox the source frame gives.
// ppp0103 derived the XZ row by hand. Real kernel, gated like the drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ExtrudeDirection, PartDoc } from '@/types/cad'
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

type Swap = (u: number, v: number) => [number, number]

// [source plane, Oversolved plane, sketch swap, direction, source-frame bbox]
const ROWS: Array<[string, string, Swap, ExtrudeDirection, number[]]> = [
  ['XY', '@builtin_plane_front', (u, v) => [u, v], 'normal', [0, 0, 0, 10, 4, 3]],
  ['XZ', '@builtin_plane_top', (u, v) => [u, -v], 'reverse', [0, -3, 0, 10, 0, 4]],
  ['YZ', '@builtin_plane_right', (u, v) => [-v, u], 'normal', [0, 0, 0, 3, 10, 4]],
]

describe.skipIf(!ready)('docs/translate.md named-plane table (real OCC + Rust solver)', () => {
  for (const [source, plane, swap, direction, bbox] of ROWS) {
    it(`${source} maps to ${plane}`, async () => {
      const result = await runHeadless({
        doc: emptyDriveDoc(),
        steps: [
          { mutation: { type: 'add_sketch', featureId: 'sk1', plane } },
          { mutation: { type: 'add_rect', featureId: 'sk1', p0: swap(0, 0), p1: swap(10, 4) } },
          { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 3, direction } },
        ],
      })
      expect(result.features).toEqual([])
      const measured = await measureHeadless(result.doc as PartDoc)
      measured!.measures.bbox!.forEach((value, i) => expect(value, `bbox[${i}]`).toBeCloseTo(bbox[i], 6))
    }, 120_000)
  }
})
