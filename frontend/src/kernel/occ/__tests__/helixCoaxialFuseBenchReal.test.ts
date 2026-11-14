// @vitest-environment node
//
// Phase-1 bench for a helical sweep fused into the cylinder it winds around:
// where does the solve spend its time, and which step is the one that never
// returns? The pipeline already emits feature progress heartbeats between its
// long kernel calls (kernel/featureProgress.ts), so the bench subscribes to
// them instead of adding test-only timing hooks to the boolean:
//
//   1. raw BRepAlgoAPI_Fuse + analytic-cylinder canonicalization
//   2. clean (ShapeUpgrade_UnifySameDomain)
//   3. adoption guard (volume reads + whole-shape BRepCheck_Analyzer)
//   4. diff and face-origin compose through the clean + cavity fold
//   5. soundness bounds (and, on a rejected first attempt, the retry)
//
// A heartbeat is never placed inside a kernel call, so the last mark a killed
// child leaves names the step that spun. The child is a second vitest process
// (the drive needs Vite's import.meta.env), killed by the parent's timeout:
// nothing in this process can interrupt a synchronous WASM call. Log-only, and
// opt-in, so a normal `just frontend` pays nothing:
//
//   cd frontend && HELIX_FUSE_BENCH=1 npx vitest run \
//     src/kernel/occ/__tests__/helixCoaxialFuseBenchReal.test.ts
//
// The measured numbers for the bug report live in
// feature/knowledgebase.history.md (bug-helix-sweep-coaxial-fuse).

import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { onFeatureStart } from '@/kernel/featureProgress'
import { runHeadless, selectHeadless, emptyDriveDoc } from '@/drive/headlessOps'
import type { PartDoc } from '@/types/cad'
import type { ScriptStep } from '@/drive/scriptRunner'

const enabled = !!process.env.HELIX_FUSE_BENCH
const child = process.env.HELIX_FUSE_BENCH_CHILD === '1'
const marksPath = process.env.HELIX_FUSE_BENCH_MARKS
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../tmp/helix-fuse-bench.jsonl')
const CHILD_TIMEOUT_MS = 120_000

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

describe.runIf(enabled && !child)('helix coaxial fuse bench (parent)', () => {
  it('runs the document in a killable child and prints the step table', () => {
    rmSync(marksPath, { force: true })
    const vitest = path.resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')
    const run = spawnSync(process.execPath, [vitest, 'run', fileURLToPath(import.meta.url)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HELIX_FUSE_BENCH: '1',
        HELIX_FUSE_BENCH_CHILD: '1',
        HELIX_FUSE_BENCH_MARKS: marksPath,
      },
      timeout: CHILD_TIMEOUT_MS,
      encoding: 'utf8',
    })
    // A synchronous WASM call cannot be interrupted from JS, so the guard is
    // the child's OS process. Node reports a spawnSync timeout as ETIMEDOUT (or
    // the signal), while a child that handles SIGTERM itself exits 143.
    const killed = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
      || (run.signal !== null && run.signal !== undefined)
      || run.status === 143
    const marks = readMarks()
    const bo = marks.filter((mark) => mark.featureId === 'bo1')
    expect(bo.length, 'the child produced no boolean progress mark').toBeGreaterThan(0)
    console.log('\nhelical sweep fused into its coaxial cylinder:')
    const labels = [
      'raw BRepAlgoAPI_Fuse + cylinder canonicalization',
      'clean (ShapeUpgrade_UnifySameDomain)',
      'adoption guard (volume reads + BRepCheck_Analyzer)',
      'diff/origin compose through the clean',
      'cavity fold',
      'soundness bounds',
    ]
    // bo[0] is the feature start; each later mark closes one bracket. A
    // rejected first attempt repeats the last two brackets as a retry.
    for (let i = 1; i < bo.length; i++) {
      const label = labels[i - 1] ?? 'retry attempt'
      console.log(`  ${label.padEnd(58)} ${(bo[i].t - bo[i - 1].t).toFixed(0).padStart(7)} ms`)
    }
    const nextLabel = labels[bo.length - 1] ?? 'retry attempt'
    if (killed) {
      console.log(`  ${nextLabel.padEnd(58)} did not finish in ${CHILD_TIMEOUT_MS / 1000} s`)
    }
    console.log(`  child: ${killed ? `killed after ${CHILD_TIMEOUT_MS / 1000} s` : `exit ${run.status}`}`)
    // The bench measures; only the instrument itself is asserted, so a healthy
    // run and a step that never returns are both a successful bench.
    expect(run.status === 0 || killed).toBe(true)
  }, CHILD_TIMEOUT_MS + 60_000)
})

interface Mark {
  featureId: string
  t: number
}

function readMarks(): Mark[] {
  try {
    return readFileSync(marksPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Mark)
  } catch {
    return []
  }
}

describe.runIf(enabled && child)('helix coaxial fuse bench (child)', () => {
  const oc = loadOcc()
  const solveBytes = loadSolver()
  let unsubscribe: (() => void) | null = null

  beforeAll(() => {
    if (!oc || !solveBytes) return
    setOccLoader(loadOcc)
    setSketchSolver(solveBytes)
    setSketchTopology(loadTopology())
    unsubscribe = onFeatureStart((featureId) => {
      appendFileSync(marksPath, JSON.stringify({ featureId, t: performance.now() }) + '\n')
    })
  })

  afterAll(() => {
    unsubscribe?.()
  })

  it('builds the thread-on-cylinder document', async () => {
    if (!oc || !solveBytes) throw new Error('HELIX_FUSE_BENCH=1 but OCC.js or the solver is absent')
    const base = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
        m({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 4] }),
        m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 4, operation: 'new' }),
      ],
    })
    expect(base.ok).toBe(true)
    const faces = (await selectHeadless(base.doc as PartDoc, {
      kind: 'face',
      where: { type: 'cylinderface' },
    }))!.queries
    const helix = await runHeadless({
      doc: base.doc as PartDoc,
      steps: [
        m({ type: 'add_helix', featureId: 'hx1', reference: faces[0] }),
        m({ type: 'set_helix_field', featureId: 'hx1', field: 'pitch', value: 2 }),
        m({ type: 'set_helix_field', featureId: 'hx1', field: 'turns', value: 2 }),
        m({ type: 'set_helix_field', featureId: 'hx1', field: 'start_angle', value: 90 }),
      ],
    })
    expect(helix.ok).toBe(true)
    const start = helix.curves!.hx1.start
    const sign = start[0] < 0 ? -1 : 1
    const sketched = await runHeadless({
      doc: helix.doc as PartDoc,
      steps: [
        m({
          type: 'add_plane',
          featureId: 'pl1',
          definition: {
            mode: 'origin_rotation',
            origin: [0, 0, start[2]],
            plane: '@builtin_plane_top',
            rotation_axis: 'z',
            rotation_angle: 0,
          },
        }),
        m({ type: 'add_sketch', featureId: 'sk2', plane: '@pl1' }),
        m({ type: 'add_rect', featureId: 'sk2', p0: [sign * 3.999, -0.25], p1: [sign * 4.499, 0.25] }),
      ],
    })
    expect(sketched.ok).toBe(true)
    const swept = await runHeadless({
      doc: sketched.doc as PartDoc,
      steps: [
        m({ type: 'add_sweep', featureId: 'sw1', sketchQuery: '$sk2', pathQuery: '@hx1', operation: 'new' }),
      ],
    })
    expect(swept.ok).toBe(true)
    // This is the step the bench is about; its marks stop at the guilty phase.
    const union = await runHeadless({
      doc: swept.doc as PartDoc,
      steps: [
        m({ type: 'add_boolean', featureId: 'bo1', operation: 'union', target: 'body_ex1', tools: ['body_sw1'] }),
      ],
    })
    expect(union.ok).toBe(true)
  }, CHILD_TIMEOUT_MS)
})
