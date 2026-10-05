// @vitest-environment node
//
// Timing probe for the bundle-rev invalidation question: what does an assembly
// pay, per part-document edit, for rebuilding that part's bundle instead of
// reusing the part editor's incremental checkpoint cache?
//
// Log-only on purpose. `bundleRebuildCost.test.ts` next door owns the
// structural assertions; a wall-clock threshold in the suite would flake on a
// contended box. This file asserts nothing about duration and runs nothing
// unless BUNDLE_BENCH is set. Collection still imports the kernel module graph
// like any test in here (~1.2 s), but not the OCC compile, which is the part
// that would actually hurt `just frontend`:
//
//   cd frontend && BUNDLE_BENCH=1 npx vitest run src/kernel/bundleRebuildCostBench.test.ts
//
// Numbers taken with it live in `feature/knowledgebase.agent.md`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadOcc } from './occ/loadOcc'
import { solveLocally, setSolveLocalsForTest } from './solveLocally'
import { setSketchSolver, resetSketchSolver } from './features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { handleBundleRequest } from './worker/solverWorker'
import type { BundleRequest } from './worker/solverProtocol'

// The gate is read FIRST and everything expensive hangs off it. Module scope
// runs at collection whether or not the describe is skipped, so an unguarded
// `await loadOcc()` here would put a WASM compile into every `just frontend`.
const enabled = !!process.env.BUNDLE_BENCH
const oc = enabled ? await loadOcc() : null
const solveBytes = enabled ? loadSolver() : null

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
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

/**
 * A native part of `n` stacked pads: one sketch + `n` extrudes, each fused onto
 * the running solid. Feature count is the axis the decision gate cares about,
 * so the fixture is parameterised by it rather than being one fixed doc.
 */
function nativePart(id: string, n: number, lastDistance = 4): Record<string, unknown> {
  const features: Record<string, unknown>[] = [rectSketch('sk1', 40, 40)]
  for (let i = 0; i < n; i++) {
    features.push({
      id: `ex${i}`,
      kind: 'extrude',
      sketch: '$sk1',
      distance: i === n - 1 ? lastDistance : 3 + i * 0.5,
      direction: 'normal',
      operation: 'add',
    })
  }
  return { id, features }
}

const STEP_BYTES = enabled
  ? new Uint8Array(readFileSync(join(__dirname, 'occ/__fixtures__/double_with_hole.step')))
  : new Uint8Array()
const STEP_FILES = new Map<string, Uint8Array>([['imp1', STEP_BYTES]])

/**
 * An imported part: the STEP fixture plus a small native tail to edit. Imported
 * bodies own a tessellation reuse path (`reuseCleanImportedBodyMeshes`) that a
 * purely native fixture would not exercise, which is why both are swept.
 */
function importedPart(id: string, thickness: number): Record<string, unknown> {
  return {
    id,
    features: [
      { id: 'imp1', kind: 'import_step', file_id: 'imp1', filename: 'double_with_hole.step' },
      rectSketch('sk1', 5, 5, '@builtin_plane_top'),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: thickness, direction: 'normal', operation: 'new' },
    ],
  }
}

let nextBundleId = 1
function bundleReq(spec: Record<string, unknown>, content_hash: string): BundleRequest {
  return { id: nextBundleId++, kind: 'buildBundle', spec, doc_id: spec.id as string, content_hash }
}

async function timed(label: string, fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now()
  await fn()
  const ms = performance.now() - t0
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(0).padStart(7)} ms`)
  return ms
}

// The BUNDLE_BENCH opt-in is the only reason this file skips on a normal run;
// when it is set, a missing artifact is a provisioning failure, not a silent
// skip. The timing itself stays log-only (a wall-clock threshold would flake on
// a contended box, and the file header documents that choice).
describe('bundle bench provisioning', () => {
  it('has OCC.js and the node solver build when BUNDLE_BENCH is set', () => {
    if (!enabled) return
    expect(oc, 'BUNDLE_BENCH=1 but OCC.js is absent - run `npm run occ:install`').toBeTruthy()
    expect(solveBytes, 'BUNDLE_BENCH=1 but the node solver build is absent - run `just wasm`').toBeTruthy()
  })
})

describe.skipIf(!oc || !solveBytes || !enabled)('bundle rebuild cost (real OCC + Rust solver, log-only)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  /**
   * One sweep over a part fixture. The three timings are the plan's a/b/c:
   *   a  part editor incremental re-solve of the edit,
   *   b  the bundle path for the same edit, with another document's bundle
   *      built in between (an assembly whose other part also missed),
   *   c  the bundle path for the same edit with nothing in between.
   * b and c differ only in whether `solveLocally`'s doc-keyed cache survived,
   * which is the whole finding: `handleBundleRequest` passes `{}`, and `{}`
   * leaves `prevState` undefined, which falls back to `lastBuildState`.
   */
  async function sweep(
    name: string,
    make: (id: string, edit: number) => Record<string, unknown>,
  ): Promise<void> {
    console.log(`\n[${name}]`)
    const other = nativePart(`${name}-other`, 3)

    // Reference: a genuine from-scratch build of the same doc. `bypassCache`
    // is how the explicit re-solve button forces one, and it is the only way
    // to get one on a doc id the engine has already seen.
    await solveLocally(make(`${name}-a`, 4))
    await timed('   full build from scratch (reference)', () =>
      solveLocally(make(`${name}-a`, 5), { bypassCache: true }))

    // a: part editor, same doc back to back.
    await solveLocally(make(`${name}-a`, 6))
    const a = await timed('a  part editor incremental re-solve', () =>
      solveLocally(make(`${name}-a`, 7)))

    // b: bundle build with a foreign document built in between.
    await handleBundleRequest(bundleReq(make(`${name}-b`, 6), 'h1'), solveLocally, STEP_FILES)
    await handleBundleRequest(bundleReq(other, 'h1'), solveLocally, STEP_FILES)
    const b = await timed('b  bundle rebuild, doc switched in between', () =>
      handleBundleRequest(bundleReq(make(`${name}-b`, 7), 'h2'), solveLocally, STEP_FILES))

    // c: bundle build with nothing in between.
    await handleBundleRequest(bundleReq(make(`${name}-c`, 6), 'h1'), solveLocally, STEP_FILES)
    const c = await timed('c  bundle rebuild, same doc back to back', () =>
      handleBundleRequest(bundleReq(make(`${name}-c`, 7), 'h2'), solveLocally, STEP_FILES))

    console.log(`  ${'b - a (cost of the doc switch)'.padEnd(46)} ${(b - a).toFixed(0).padStart(7)} ms`)
    console.log(`  ${'c - a (cost of the bundle path itself)'.padEnd(46)} ${(c - a).toFixed(0).padStart(7)} ms`)
  }

  it('native part, by feature count', async () => {
    for (const n of [5, 10, 20, 40]) {
      await sweep(`native${n}`, (id, edit) => nativePart(id, n, edit))
    }
  }, 900_000)

  it('imported STEP part', async () => {
    await sweep('imported', (id, edit) => importedPart(id, edit))
  }, 900_000)
})
