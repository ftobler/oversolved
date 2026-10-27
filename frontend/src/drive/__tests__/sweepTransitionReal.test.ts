// @vitest-environment node
//
//
// A swept square around a U path: the default mitre keeps the profile's full
// section through each corner (volume = area x path length), while `round`
// turns the corner on an arc and loses a little material. The numbers are the
// CadQuery transition="right" and transition="round" results (door.py handle).
// Real kernel, gated like the drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import type { PartDoc } from '@/types/cad'
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

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

const HANDLE: ScriptStep[] = [
  m({ type: 'add_sketch', featureId: 'path', plane: '@builtin_plane_front' }),
  m({ type: 'add_entity', featureId: 'path', kind: 'line', params: [0, 0, 20, 0] }),
  m({ type: 'add_entity', featureId: 'path', kind: 'line', params: [20, 0, 20, 50] }),
  m({ type: 'add_entity', featureId: 'path', kind: 'line', params: [20, 50, 0, 50] }),
  m({ type: 'add_sketch', featureId: 'prof', plane: '@builtin_plane_right' }),
  m({ type: 'add_center_rect', featureId: 'prof', center: [0, 0], corner: [2, 2] }),
  m({ type: 'add_sweep', featureId: 'sw', sketchQuery: '$prof', pathQuery: '$path' }),
]

async function volumeWith(extra: ScriptStep[]): Promise<number> {
  const run = await runHeadless({ doc: emptyDriveDoc(), steps: [...HANDLE, ...extra] })
  expect(run.features).toEqual([])
  return (await measureHeadless(run.doc as PartDoc))!.measures.volume
}

describe.skipIf(!ready)('sweep transition (real OCC + Rust solver)', () => {
  it('mitres the corners by default', async () => {
    expect(await volumeWith([])).toBeCloseTo(1440, 3)
  })

  it('rounds the corners when asked', async () => {
    const set = m({ type: 'set_sweep_field', featureId: 'sw', field: 'transition', value: 'round' })
    expect(await volumeWith([set])).toBeCloseTo(1433.1327, 3)
  })
}, 120_000)
