// @vitest-environment node
//
// Full-document regression test: replays the 70 PartDoc specs from the
// regression baseline through the TS/WASM kernel (OCC.js + Rust sketch solver)
// and diffs the output against the frozen baseline.
//
// The baseline (regression-baseline.json) is a golden snapshot of the kernel's
// own earlier output, regenerated with `npm run regen:corpus`
// (scripts/regenCorpus.ts + mergeCorpus.py). A failure means a whole document
// now builds differently; if that change is intended, regenerate and review
// the JSON diff. The corpus was first frozen from the deleted Python kernel,
// which is where the "parity" name of the old dedicated gate came from.
//
// Part of the default suite. Skips when OCC.js or the Rust WASM is absent,
// like every *Real suite; under CI the provisioning guard turns that skip into
// a failure. Provision locally with `just install-occ` and `just wasm`.

import { createRequire } from 'node:module'
import { describe, it, expect, afterAll } from 'vitest'
import { unportedKinds } from '../../solverRegistry'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import {
  solveWithTimeout,
  disposeWorker,
  setSolveChildForTest,
  resetSolveChildForTest,
  type SolveChildLike,
} from '../../solveTimeout'
import type { BuildResponse } from '../../builder'
import { buildBaselineBody } from '@/wasm-kernel/baselineBody'
import baseline from '@/wasm-kernel/regression-baseline.json'

// ─── Provisioning ───

// Every solve runs in the forked child of solveWithTimeout, which loads its own
// OCC.js. Loading it here as well would only answer "is it installed" at the
// cost of a second ~0.75 GB heap in this fork, which the memory-sized pool in
// vitest.config.ts does not budget for. Resolving the package is enough.
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
const topologyBytes = loadTopology()

// The solve child runs the TS sources through --experimental-strip-types,
// which Node only has from 22.6. package.json still allows 20.19, so on an
// older Node the documents cannot be solved here at all; skip them rather than
// report every entry as a null solve.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const stripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)

// Set only by the CI jobs that provision OCC.js and both WASM builds. Keying on
// plain CI would also fire in the GitHub main check, which skips provisioning
// on purpose and accepts the self-skip.
const provisionedJob = !!process.env.KERNEL_PROVISIONED

// The first entry pays the child's cold start (fork, load OCC.js, compile the
// WASM) on top of its solve, which solveWithTimeout caps at 30 s. The default
// local timeout of 5 s would flake on that, so the replay carries its own,
// equal to the CI timeout in vitest.config.ts so the arm64 runner keeps its
// allowance.
const ENTRY_TIMEOUT_MS = 180_000

// ─── Baseline types ───

interface BaselineEntry {
  label: string
  ok: boolean
  error: string | null
  spec: Record<string, unknown>
  input_sketches?: unknown[]
  result: Record<string, unknown>
  bodies: Record<string, BaselineBody>
  // Real-doc anchors are a best-effort signal: warn on divergence, never
  // hard-fail. They surface remaining TS-kernel gaps without blocking the gate.
  soft?: boolean
}

interface BaselineBody {
  id: string
  created_by: string
  modified_by: string[]
  mesh: { vertices: number[][]; faces: number[][] }
  face_count: number
  edge_count: number
  face_hashes: string[]
  edge_hashes: string[]
  mesh_error?: string
}

const entries = baseline as unknown as BaselineEntry[]

// ─── Diff helpers ───

function sortHashes(arr: string[]): string[] {
  return [...arr].sort()
}

function diffResult(
  tsResult: Record<string, unknown>,
  baseResult: Record<string, unknown>,
  label: string,
): string[] {
  const issues: string[] = []
  const tsKeys = new Set(Object.keys(tsResult))
  const baseKeys = new Set(Object.keys(baseResult))

  for (const key of baseKeys) {
    if (!tsKeys.has(key)) {
      issues.push(`${label}/result/${key}: missing in TS output`)
      continue
    }
    const tsVal = tsResult[key] as Record<string, unknown> | undefined
    const baseVal = baseResult[key] as Record<string, unknown> | undefined
    if (!tsVal || !baseVal) continue

    // Compare status. On a TS exception, surface the error so the gate says
    // *why* a feature failed, not just that it did.
    if (tsVal.status !== baseVal.status) {
      const detail = tsVal.status === 'exception' ? ` (${String(tsVal.exception)})` : ''
      issues.push(`${label}/result/${key}/status: TS=${tsVal.status} baseline=${baseVal.status}${detail}`)
    }

    // Compare geometry (for sketch features). Gauge-free: underconstrained
    // entities live on a shared solution manifold where any two solves may
    // legitimately land on different points, so only compare geometry where
    // the baseline marks the entity determinate.
    const tsGeom = tsVal.geometry as Record<string, number[]> | undefined
    const baseGeom = baseVal.geometry as Record<string, number[]> | undefined
    const tsGeomFeat = tsVal.features as Record<string, { status: string }> | undefined
    const baseGeomFeat = baseVal.features as Record<string, { status: string }> | undefined
    if (tsGeom && baseGeom) {
      for (const [eid, baseParams] of Object.entries(baseGeom)) {
        if (baseGeomFeat?.[eid]?.status !== 'fully_constrained') continue
        const tsParams = tsGeom[eid]
        if (!tsParams) {
          issues.push(`${label}/result/${key}/geometry/${eid}: missing in TS`)
          continue
        }
        if (tsParams.length !== baseParams.length) {
          issues.push(`${label}/result/${key}/geometry/${eid}: length mismatch`)
          continue
        }
        for (let i = 0; i < baseParams.length; i++) {
          if (Math.abs(tsParams[i] - baseParams[i]) > 1e-3) {
            issues.push(
              `${label}/result/${key}/geometry/${eid}[${i}]: TS=${tsParams[i].toFixed(4)} baseline=${baseParams[i].toFixed(4)}`,
            )
          }
        }
      }

      // Reverse geometry pass: entities the live kernel solved but the baseline
      // never had are extra on the TS side. Only flag determinate entities so
      // gauge-free/underconstrained ones (shared solution manifold) stay quiet.
      for (const eid of Object.keys(tsGeom)) {
        if (eid in baseGeom) continue
        if (tsGeomFeat?.[eid]?.status !== 'fully_constrained') continue
        issues.push(`${label}/result/${key}/geometry/${eid}: extra in TS`)
      }
    }

    // Compare per-entity status (for sketch features)
    const tsFeat = tsVal.features as Record<string, { status: string }> | undefined
    const baseFeat = baseVal.features as Record<string, { status: string }> | undefined
    if (tsFeat && baseFeat) {
      for (const [eid, baseEnt] of Object.entries(baseFeat)) {
        const tsEnt = tsFeat[eid]
        if (!tsEnt) {
          issues.push(`${label}/result/${key}/features/${eid}: missing in TS`)
          continue
        }
        if (tsEnt.status !== baseEnt.status) {
          issues.push(
            `${label}/result/${key}/features/${eid}/status: TS=${tsEnt.status} baseline=${baseEnt.status}`,
          )
        }
      }

      // Reverse per-entity pass: entities the live kernel produced but the
      // baseline never froze are extra on the TS side.
      for (const eid of Object.keys(tsFeat)) {
        if (!(eid in baseFeat)) {
          issues.push(`${label}/result/${key}/features/${eid}: extra in TS`)
        }
      }
    }
  }

  // Symmetric pass: keys the live TS kernel produced but the frozen baseline
  // never saw are extra features/entities on the TS side. One-directional diffs
  // silently pass these, so flag them explicitly.
  for (const key of tsKeys) {
    if (!baseKeys.has(key)) {
      issues.push(`${label}/result/${key}: missing in baseline`)
    }
  }

  return issues
}

function sortedVerts(v: number[][]): number[][] {
  return [...v].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
}

const VERT_TOL = 1e-4

function diffBodies(
  tsBodies: Record<string, Record<string, unknown>>,
  baseBodies: Record<string, BaselineBody>,
  label: string,
): string[] {
  const issues: string[] = []

  for (const [bid, baseBody] of Object.entries(baseBodies)) {
    const tsBody = tsBodies[bid]
    if (!tsBody) {
      issues.push(`${label}/bodies/${bid}: missing in TS output`)
      continue
    }

    // Lineage identity.
    if ((tsBody.created_by ?? '') !== baseBody.created_by) {
      issues.push(`${label}/bodies/${bid}/created_by: TS=${tsBody.created_by} baseline=${baseBody.created_by}`)
    }
    const tsMod = sortHashes((tsBody.modified_by as string[]) ?? [])
    const baseMod = sortHashes(baseBody.modified_by ?? [])
    if (JSON.stringify(tsMod) !== JSON.stringify(baseMod)) {
      issues.push(`${label}/bodies/${bid}/modified_by: TS=[${tsMod}] baseline=[${baseMod}]`)
    }

    // mesh_error presence must match (a silent unit-cube fallback must not pass).
    const tsErr = tsBody.mesh_error != null
    const baseErr = baseBody.mesh_error != null
    if (tsErr !== baseErr) {
      issues.push(`${label}/bodies/${bid}/mesh_error: TS=${tsErr} baseline=${baseErr}`)
    }

    // Structural counts. A missing or non-numeric count must fail, never pass
    // as if it matched: the live body is always enriched to carry real numbers.
    const faceCountOk = typeof tsBody.face_count === 'number' && tsBody.face_count === baseBody.face_count
    const edgeCountOk = typeof tsBody.edge_count === 'number' && tsBody.edge_count === baseBody.edge_count
    if (!faceCountOk) {
      issues.push(`${label}/bodies/${bid}/face_count: TS=${tsBody.face_count} baseline=${baseBody.face_count}`)
    }
    if (!edgeCountOk) {
      issues.push(`${label}/bodies/${bid}/edge_count: TS=${tsBody.edge_count} baseline=${baseBody.edge_count}`)
    }

    // Vertex multiset within tolerance (count is a fast pre-filter).
    let vertsOk = false
    const tsMesh = tsBody.mesh as { vertices?: number[][] } | undefined
    if (tsMesh?.vertices && baseBody.mesh.vertices) {
      const tsV = tsMesh.vertices
      const baseV = baseBody.mesh.vertices
      if (tsV.length !== baseV.length) {
        issues.push(`${label}/bodies/${bid}/vertices: count TS=${tsV.length} baseline=${baseV.length}`)
      } else {
        const a = sortedVerts(tsV)
        const b = sortedVerts(baseV)
        let maxd = 0
        for (let i = 0; i < a.length; i++) {
          maxd = Math.max(
            maxd,
            Math.abs(a[i][0] - b[i][0]),
            Math.abs(a[i][1] - b[i][1]),
            Math.abs(a[i][2] - b[i][2]),
          )
        }
        if (maxd > VERT_TOL) {
          issues.push(`${label}/bodies/${bid}/vertices: max delta ${maxd.toFixed(5)} > ${VERT_TOL}`)
        } else {
          vertsOk = true
        }
      }
    }

    // Geometry-hash set equality. A hash mismatch when counts AND the vertex
    // multiset already match is the accepted curved-face divergence: entries
    // still frozen from the Python kernel sampled curved centroids/normals
    // slightly differently from OCC.js, and the 4dp
    // hash rounding is sensitive to it, though the body is equal within
    // tolerance. Warn but do not fail -- the structural + vertex checks already
    // passed. Any hash mismatch with a count or vertex mismatch stays a failure.
    const bodyGeomOk = faceCountOk && edgeCountOk && vertsOk
    for (const field of ['face_hashes', 'edge_hashes'] as const) {
      const tsHashes = sortHashes((tsBody[field] as string[]) ?? [])
      const baseHashes = sortHashes((baseBody[field] as string[]) ?? [])
      if (JSON.stringify(tsHashes) !== JSON.stringify(baseHashes)) {
        const msg = `${label}/bodies/${bid}/${field}: mismatch (TS=${tsHashes.length} baseline=${baseHashes.length})`
        if (bodyGeomOk) {
          console.warn(`[regression] ${msg} -- accepted curved-face divergence`)
        } else {
          issues.push(msg)
        }
      }
    }
  }

  // Symmetric pass: bodies the live TS kernel produced but the baseline never
  // froze are extra bodies on the TS side (e.g. a boolean that leaves two
  // bodies instead of fusing). Flag them rather than letting them pass unseen.
  for (const bid of Object.keys(tsBodies)) {
    if (!(bid in baseBodies)) {
      issues.push(`${label}/bodies/${bid}: extra body in TS output`)
    }
  }

  return issues
}

// ─── Post-process body data (worker returns raw mesh, not hashes) ───

// The body output carries the live mesh + edges; reduce it to the same golden
// shape the corpus generator (scripts/regenCorpus.ts) freezes, so replaying the
// baseline diffs TS-live against TS-frozen byte-identically. The spread of the
// live body on top deliberately overwrites the golden created_by/modified_by
// with the live lineage the diff compares against, and keeps the extra fields
// (mesh_error, edges, queries) that diffBodies reads but the golden shape drops.
// The golden face_count/edge_count and geometry hashes survive because the live
// body carries none of them.
function enrichBodyHashes(
  bid: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return { ...buildBaselineBody(bid, body), ...body }
}

// ─── Null-solve guard ───

// The forked child returns null when OCC.js fails to load inside the worker or
// the child OOMs. In this gate that is a real failure, never a skip: without
// this guard a broken worker would turn every replayed entry into a pass.
function assertSolveResponse(
  tsResponse: BuildResponse | null,
  label: string,
): asserts tsResponse is BuildResponse {
  if (!tsResponse) {
    throw new Error(
      `[regression] ${label}: solve produced no response ` +
        `(worker-side OCC.js load failure or forked-child OOM?)`,
    )
  }
}

// Test-only fake child that answers every solve request with ok + null, i.e.
// exactly the "OCC.js unavailable" branch of the runner.
class NullSolveChild {
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  send(msg: Record<string, unknown>): void {
    const id = (msg as { id: number }).id
    this.listeners.get('message')?.forEach((cb) => cb({ id, ok: true, result: null }))
  }
  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
  }
  kill(): void {}
}

// ─── Test suite ───

// The replay below is wrapped in a skipIf on provisioning. That makes a
// provisioning regression (OCC.js absent, WASM build missing, baseline
// corrupted) look like a green 0-test run instead of a failure. These guards
// live outside the skipIf suite so such a regression fails loudly. They check
// only the module-load results, which are null (never throw) when provisioning
// is absent, so they do not need OCC/WASM to actually load.
describe('regression provisioning guard', () => {
  // A KERNEL_PROVISIONED job installs OCC.js, both WASM builds and a
  // strip-types Node, so a skip there is a broken job. Locally an unprovisioned checkout skips the replay
  // like every *Real suite, and `just frontend` stays usable without OCC.js.
  // The 20.x leg of the CI Node matrix is the one allowed exception: it cannot
  // run the solve child, so it checks only what it can provide.
  it.runIf(provisionedJob)('has all provisioning globals (OCC.js + solver + topology WASM)', () => {
    expect(oc, 'oc: OCC.js absent - run `just install-occ`').toBeTruthy()
    expect(solveBytes, 'solveBytes: Rust solver WASM absent - run `just wasm`').toBeTruthy()
    expect(topologyBytes, 'topologyBytes: topology WASM absent - run `just wasm`').toBeTruthy()
  })

  it('has a non-trivial baseline corpus (not empty/corrupt)', () => {
    expect(entries.length, 'baseline corpus is empty or corrupted').toBeGreaterThanOrEqual(20)
  })

  // A valid-JSON baseline of all-failed entries would pass the corpus-count
  // guard and make every replayed entry hit the warn-and-return branch, so
  // require at least one entry the replay actually solves.
  it('has at least one baseline entry marked ok', () => {
    expect(entries.some((e) => e.ok), 'baseline corpus has no ok:true entry').toBe(true)
  })
})

// The null-solve guard does not need OCC.js (it uses a fake child), so it lives
// outside the skipIf suite and still runs when the kernel is not provisioned.
describe('regression null-solve guard', () => {
  it('fails loudly when the solve returns null (worker load failure or child OOM)', async () => {
    setSolveChildForTest(() => new NullSolveChild() as unknown as SolveChildLike)
    try {
      await expect(
        (async () => {
          const response = await solveWithTimeout({}, { prevState: null })
          assertSolveResponse(response, 'null-solve-branch')
        })(),
      ).rejects.toThrow(/solve produced no response/)
    } finally {
      resetSolveChildForTest()
    }
  })
})

const provisioned = oc && !!solveBytes && !!topologyBytes && stripTypes

describe.skipIf(!provisioned)('full-doc regression (TS kernel vs frozen baseline)', () => {
  // The pooled solve child would otherwise outlive this file in its fork.
  afterAll(() => disposeWorker())

  for (const entry of entries) {
    it(entry.label, { timeout: ENTRY_TIMEOUT_MS }, async () => {
      const spec = entry.spec
      if (!spec || !entry.ok) {
        if (!entry.ok) {
          // A baseline entry the kernel could not build when it was frozen is
          // not a regression, so it must not fail the gate; the provisioning
          // guard above (`has at least one baseline entry marked ok`) keeps an
          // all-failed corpus from hiding behind this branch, and the warning
          // is the visible record of the skip.
          console.warn(`[regression] ${entry.label}: frozen build failed, skipping`)
        }
        return
      }

      // Mirror the live router: a doc with any unported kind is unsolvable
      // (isDocFullyPorted === false) -- useSolver surfaces a "Cannot solve"
      // error rather than running the TS kernel. Don't fail it here; that would
      // test a path production never takes.
      const features = (spec.features as Array<{ kind?: unknown }>) ?? []
      const unported = unportedKinds(features)
      if (unported.size > 0) {
        console.warn(`[regression] ${entry.label}: skipped (unported kinds: ${[...unported].join(', ')})`)
        return
      }

      const tsResponse = await solveWithTimeout(spec, { prevState: null })
      assertSolveResponse(tsResponse, entry.label)
      const tsResult = tsResponse.result as Record<string, unknown>
      const rawBodies = tsResponse.bodies as Record<string, Record<string, unknown>>
      const tsBodies: Record<string, Record<string, unknown>> = {}
      for (const [bid, body] of Object.entries(rawBodies)) {
        tsBodies[bid] = enrichBodyHashes(bid, body)
      }

      const allIssues: string[] = [
        ...diffResult(tsResult, entry.result, entry.label),
        ...diffBodies(tsBodies, entry.bodies, entry.label),
      ]

      if (allIssues.length > 0) {
        // Hard-fail by default: this is the enforced regression gate. A per-entry
        // `soft` flag (real-doc anchors) or REGRESSION_SOFT=1 downgrades to a
        // warn-only inventory -- a best-effort signal that never blocks the gate.
        const msg = `${allIssues.length} issue(s): ${allIssues.join('; ')}`
        const soft = import.meta.env.REGRESSION_SOFT === '1' || entry.soft === true
        if (soft) {
          const tag = entry.soft ? 'REAL-SOFT' : 'SOFT'
          // Warn-only inventory: the console.warn below IS the artifact and the
          // issues are already in `msg`. No assertion here on purpose, so a soft
          // anchor never blocks the gate.
          console.warn(`[regression] ${entry.label}: ${tag} ${msg}`)
        } else {
          expect(allIssues.length, msg).toBe(0)
        }
      }
    })
  }
})
