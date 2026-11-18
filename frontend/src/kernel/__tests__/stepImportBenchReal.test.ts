// @vitest-environment node
//
// Phase timings of a STEP import through the real solve path: the import leaf
// (read, transfer, identity map, names, split), the mesh-free metadata pass and
// the post-loop render pass, each charged through occ/phaseTimer.ts at its
// production call site, so this measures the pipeline the app runs rather than
// a copy of it.
//
// Log-only, like bundleRebuildCostBenchReal.test.ts: a wall-clock threshold
// would flake on a contended box. It runs nothing unless STEP_BENCH is set:
//
//   cd frontend && STEP_BENCH=1 npx vitest run src/kernel/__tests__/stepImportBenchReal.test.ts
//
// STEP_BENCH_FILES takes a comma-separated list of project-relative STEP paths
// (relative to the repo root) in place of the default set. Each file is solved
// twice from scratch: the first solve of the process also pays the WASM tier-up,
// the second is the steady state. Numbers live in feature/step-load-speed.md.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { solveLocally, setSolveLocalsForTest, warmUpLocally } from '../solveLocally'
import type { WarmUpState } from '../occ/warmUp'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { startPhaseTiming, stopPhaseTiming, type PhaseTotal } from '../occ/phaseTimer'

// The gate is read first so collection never compiles OCC for `just frontend`.
const enabled = !!process.env.STEP_BENCH
const oc = enabled ? await loadOcc() : null
const solveBytes = enabled ? loadSolver() : null

const REPO_ROOT = resolve(__dirname, '../../../..')
// The fixture is checked in; the others are copied into the tree's own tmp/
// (scratch inputs, not evidence) and skip when absent: extruder.step from
// tmp/practice-ref, the rest from scratch/code-cad-examples.
const DEFAULT_FILES = [
  'frontend/src/kernel/occ/__fixtures__/double_with_hole.step',
  'tmp/bench-step/extruder.step',
  'tmp/bench-step/as1-oc-214.stp',
  'tmp/bench-step/walkie-talkie.step',
  'tmp/bench-step/Ventilator.stp',
]
const files = (process.env.STEP_BENCH_FILES?.split(',') ?? DEFAULT_FILES)
  .map((p) => p.trim())
  .filter((p) => p.length > 0)

// Report order: the import leaf, then the metadata pass, then the render pass,
// with the render mesh's two inner halves under it.
const PHASES = [
  'step.read', 'step.transfer', 'step.identity', 'import.names', 'import.split',
  'meta.faces', 'meta.edges', 'meta.vertices',
  'render.faceFacts', 'render.mesh', 'mesh.triangulate', 'mesh.mesher', 'mesh.faceFacts',
  // render.faceEdges covers the seam lists too since they share one walk.
  'render.edges', 'render.vertices', 'render.faceEdges',
]

interface Run {
  totalMs: number
  phases: Map<string, PhaseTotal>
  bodies: number
  faces: number
  triangles: number
}

async function solveOnce(path: string, docId: string): Promise<Run> {
  const bytes = new Uint8Array(readFileSync(path))
  const spec = { id: docId, features: [{ id: 'imp1', kind: 'import_step', file_id: 'imp1', scale: 1 }] }
  startPhaseTiming()
  const start = performance.now()
  const res = await solveLocally(spec, { bypassCache: true, files: new Map([['imp1', bytes]]) })
  const totalMs = performance.now() - start
  const phases = stopPhaseTiming()
  expect(res).not.toBeNull()
  const parts = (res?.bodies ?? {}) as Record<string, { mesh?: { faces?: unknown[]; face_data?: unknown[] } }>
  let faces = 0
  let triangles = 0
  for (const part of Object.values(parts)) {
    faces += part.mesh?.face_data?.length ?? 0
    triangles += part.mesh?.faces?.length ?? 0
  }
  return { totalMs, phases, bodies: Object.keys(parts).length, faces, triangles }
}

function report(name: string, label: string, run: Run): void {
  const lines = [`${name} [${label}] total ${run.totalMs.toFixed(0)} ms, ` +
    `${run.bodies} bodies, ${run.faces} faces, ${run.triangles} triangles`]
  for (const phase of PHASES) {
    const t = run.phases.get(phase)
    if (!t) continue
    const share = (100 * t.ms / run.totalMs).toFixed(1)
    lines.push(`  ${phase.padEnd(18)} ${t.ms.toFixed(0).padStart(7)} ms  ${share.padStart(5)} %  (${t.calls} calls)`)
  }
  console.log(lines.join('\n'))
}

describe.skipIf(!enabled)('STEP import phase bench', () => {
  beforeAll(async () => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
    // STEP_BENCH_WARM runs the Worker's idle warm-up first, to compare the
    // first file's first solve with and without it.
    if (process.env.STEP_BENCH_WARM) {
      const state: WarmUpState = {}
      const start = performance.now()
      let step = 0
      while (await warmUpLocally(step, state)) step++
      console.log(`warm-up: ${step} steps, ${(performance.now() - start).toFixed(0)} ms`)
    }
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  for (const rel of files) {
    const path = join(REPO_ROOT, rel)
    it.skipIf(!existsSync(path))(basename(rel), async () => {
      report(basename(rel), 'first', await solveOnce(path, `bench-${basename(rel)}-a`))
      report(basename(rel), 'repeat', await solveOnce(path, `bench-${basename(rel)}-b`))
    }, 600_000)
  }
})
