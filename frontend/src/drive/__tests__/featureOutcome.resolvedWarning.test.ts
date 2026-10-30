// @vitest-environment node
//
// A "the new solid also touches ... add a boolean union" warning must stop
// being a problem once a later feature has fused the bodies it names. The kernel
// resolves it against the final stack, the drive problem list drops it, and the
// original text is exposed as `resolvedWarning` for a greyed display.
//
// Geometry: three separate posts, then a fourth additive extrude whose bar
// overlaps all three. It fuses into the first post it reaches and warns about the
// other two; a boolean union then fuses them into one live body.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
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

// A post on Front, x0..x0+width, extruded to z 0..3 as its own body.
function post(n: number, x0: number, width: number): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: `sk${n}`, plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: `sk${n}`, p0: [x0, 0], p1: [x0 + width, 2] }),
    m({ type: 'add_extrude', featureId: `ex${n}`, sketchQuery: `$sk${n}`, distance: 3, operation: 'new' }),
  ]
}

// One bar over x1..11: additive with no merge_target, so it fuses into the first
// post it reaches (body_ex1) and touches the posts at x5..7 and x10..12.
function bridge(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk4', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'sk4', p0: [1, 0], p1: [11, 2] }),
    m({ type: 'add_extrude', featureId: 'ex4', sketchQuery: '$sk4', distance: 3 }),
  ]
}

function union(tools: string[]): ScriptStep[] {
  return [m({ type: 'add_boolean', featureId: 'bo1', operation: 'union', target: 'body_ex1', tools })]
}

const posts = (): ScriptStep[] => [...post(1, 0, 2), ...post(2, 5, 2), ...post(3, 10, 2), ...bridge()]
const original = 'extrude: the new solid also touches body_ex2, body_ex3; add a boolean union to fuse it'

describe.skipIf(!ready)('a touch warning resolved by a later union (real OCC + Rust solver)', () => {
  it('stays a problem while the bodies remain separate', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: posts() })
    const problem = result.features.find((p) => p.id === 'ex4')
    expect(problem?.message).toContain('also touches body_ex2, body_ex3')
    expect(result.part.solveOutcomes().ex4?.resolvedWarning).toBeUndefined()
    expect(result.part.solveOutcomes().ex4?.warning).toContain('also touches')
  }, 120_000)

  it('leaves the problem list once one union fused every named body', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: [...posts(), ...union(['body_ex2', 'body_ex3'])] })
    expect(result.ok).toBe(true)
    expect(result.features).toEqual([])
    expect(result.part.solveOutcomes().ex4?.resolvedWarning).toBe(original)
    expect(result.part.solveOutcomes().ex4?.warning).toBeUndefined()
  }, 120_000)

  it('rewrites the text to name only the bodies the union left apart', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: [...posts(), ...union(['body_ex2'])] })
    const problem = result.features.find((p) => p.id === 'ex4')
    expect(problem?.message).toContain('also touches body_ex3')
    expect(problem?.message).not.toContain('body_ex2')
    expect(result.part.solveOutcomes().ex4?.resolvedWarning).toBeUndefined()
  }, 120_000)
})
