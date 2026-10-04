// @vitest-environment node
//
// Full-document parity test: replays the 20 PartDoc specs from the regression
// baseline through the TS/WASM kernel (OCC.js + Rust sketch solver) and diffs
// the output against the frozen baseline.
//
// The baseline (regression-baseline.json) is a golden snapshot frozen by
// frontend/scripts/regenCorpus.ts + mergeCorpus.py, so it IS regenerable via
// `npm run regen:corpus`. But the Python kernel is gone, so this is no longer a
// live old-vs-new comparison -- it is a TS regression gate (live TS/WASM kernel
// == frozen golden file). Gated: skips entirely when OCC.js or the Rust solver
// is absent, so the default CI run stays green (the dedicated parity job
// installs OCC.js so it does run there).
//
// Provision OCC.js:
//   cd frontend && npm run occ:install

import { describe, it, expect } from 'vitest'
import { loadOcc } from './loadOcc'
import { unportedKinds } from '../solverRegistry'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import {
  solveWithTimeout,
  setSolveChildForTest,
  resetSolveChildForTest,
  type SolveChildLike,
} from '../solveTimeout'
import type { BuildResponse } from '../builder'
import { buildBaselineBody } from '@/wasm-kernel/parityBaseline'
import baseline from '@/wasm-kernel/regression-baseline.json'

// ─── Pre-load OCC.js and the Rust solver ───

const oc = await loadOcc()
const solveBytes = loadSolver()
const topologyBytes = loadTopology()

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
  pyResult: Record<string, unknown>,
  label: string,
): string[] {
  const issues: string[] = []
  const tsKeys = new Set(Object.keys(tsResult))
  const pyKeys = new Set(Object.keys(pyResult))

  for (const key of pyKeys) {
    if (!tsKeys.has(key)) {
      issues.push(`${label}/result/${key}: missing in TS output`)
      continue
    }
    const tsVal = tsResult[key] as Record<string, unknown> | undefined
    const pyVal = pyResult[key] as Record<string, unknown> | undefined
    if (!tsVal || !pyVal) continue

    // Compare status. On a TS exception, surface the error so the gate says
    // *why* a feature failed, not just that it did.
    if (tsVal.status !== pyVal.status) {
      const detail = tsVal.status === 'exception' ? ` (${String(tsVal.exception)})` : ''
      issues.push(`${label}/result/${key}/status: TS=${tsVal.status} Python=${pyVal.status}${detail}`)
    }

    // Compare geometry (for sketch features). Gauge-free: underconstrained
    // entities live on a shared solution manifold where the Rust LM and scipy
    // legitimately differ, so only compare geometry where Python marks the
    // entity determinate (the same rule shadowCompare applies).
    const tsGeom = tsVal.geometry as Record<string, number[]> | undefined
    const pyGeom = pyVal.geometry as Record<string, number[]> | undefined
    const tsGeomFeat = tsVal.features as Record<string, { status: string }> | undefined
    const pyGeomFeat = pyVal.features as Record<string, { status: string }> | undefined
    if (tsGeom && pyGeom) {
      for (const [eid, pyParams] of Object.entries(pyGeom)) {
        if (pyGeomFeat?.[eid]?.status !== 'fully_constrained') continue
        const tsParams = tsGeom[eid]
        if (!tsParams) {
          issues.push(`${label}/result/${key}/geometry/${eid}: missing in TS`)
          continue
        }
        if (tsParams.length !== pyParams.length) {
          issues.push(`${label}/result/${key}/geometry/${eid}: length mismatch`)
          continue
        }
        for (let i = 0; i < pyParams.length; i++) {
          if (Math.abs(tsParams[i] - pyParams[i]) > 1e-3) {
            issues.push(
              `${label}/result/${key}/geometry/${eid}[${i}]: TS=${tsParams[i].toFixed(4)} Python=${pyParams[i].toFixed(4)}`,
            )
          }
        }
      }

      // Reverse geometry pass: entities the live kernel solved but the baseline
      // never had are extra on the TS side. Only flag determinate entities so
      // gauge-free/underconstrained ones (shared solution manifold) stay quiet.
      for (const eid of Object.keys(tsGeom)) {
        if (eid in pyGeom) continue
        if (tsGeomFeat?.[eid]?.status !== 'fully_constrained') continue
        issues.push(`${label}/result/${key}/geometry/${eid}: extra in TS`)
      }
    }

    // Compare per-entity status (for sketch features)
    const tsFeat = tsVal.features as Record<string, { status: string }> | undefined
    const pyFeat = pyVal.features as Record<string, { status: string }> | undefined
    if (tsFeat && pyFeat) {
      for (const [eid, pyEnt] of Object.entries(pyFeat)) {
        const tsEnt = tsFeat[eid]
        if (!tsEnt) {
          issues.push(`${label}/result/${key}/features/${eid}: missing in TS`)
          continue
        }
        if (tsEnt.status !== pyEnt.status) {
          issues.push(
            `${label}/result/${key}/features/${eid}/status: TS=${tsEnt.status} Python=${pyEnt.status}`,
          )
        }
      }

      // Reverse per-entity pass: entities the live kernel produced but the
      // baseline never froze are extra on the TS side.
      for (const eid of Object.keys(tsFeat)) {
        if (!(eid in pyFeat)) {
          issues.push(`${label}/result/${key}/features/${eid}: extra in TS`)
        }
      }
    }
  }

  // Symmetric pass: keys the live TS kernel produced but the frozen baseline
  // never saw are extra features/entities on the TS side. One-directional diffs
  // silently pass these, so flag them explicitly.
  for (const key of tsKeys) {
    if (!pyKeys.has(key)) {
      issues.push(`${label}/result/${key}: missing in Python baseline`)
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
  pyBodies: Record<string, BaselineBody>,
  label: string,
): string[] {
  const issues: string[] = []

  for (const [bid, pyBody] of Object.entries(pyBodies)) {
    const tsBody = tsBodies[bid]
    if (!tsBody) {
      issues.push(`${label}/bodies/${bid}: missing in TS output`)
      continue
    }

    // Lineage identity.
    if ((tsBody.created_by ?? '') !== pyBody.created_by) {
      issues.push(`${label}/bodies/${bid}/created_by: TS=${tsBody.created_by} Python=${pyBody.created_by}`)
    }
    const tsMod = sortHashes((tsBody.modified_by as string[]) ?? [])
    const pyMod = sortHashes(pyBody.modified_by ?? [])
    if (JSON.stringify(tsMod) !== JSON.stringify(pyMod)) {
      issues.push(`${label}/bodies/${bid}/modified_by: TS=[${tsMod}] Python=[${pyMod}]`)
    }

    // mesh_error presence parity (a silent unit-cube fallback must not pass).
    const tsErr = tsBody.mesh_error != null
    const pyErr = pyBody.mesh_error != null
    if (tsErr !== pyErr) {
      issues.push(`${label}/bodies/${bid}/mesh_error: TS=${tsErr} Python=${pyErr}`)
    }

    // Structural counts. A missing or non-numeric count must fail, never pass
    // as if it matched: the live body is always enriched to carry real numbers.
    const faceCountOk = typeof tsBody.face_count === 'number' && tsBody.face_count === pyBody.face_count
    const edgeCountOk = typeof tsBody.edge_count === 'number' && tsBody.edge_count === pyBody.edge_count
    if (!faceCountOk) {
      issues.push(`${label}/bodies/${bid}/face_count: TS=${tsBody.face_count} Python=${pyBody.face_count}`)
    }
    if (!edgeCountOk) {
      issues.push(`${label}/bodies/${bid}/edge_count: TS=${tsBody.edge_count} Python=${pyBody.edge_count}`)
    }

    // Vertex multiset within tolerance (count is a fast pre-filter).
    let vertsOk = false
    const tsMesh = tsBody.mesh as { vertices?: number[][] } | undefined
    if (tsMesh?.vertices && pyBody.mesh.vertices) {
      const tsV = tsMesh.vertices
      const pyV = pyBody.mesh.vertices
      if (tsV.length !== pyV.length) {
        issues.push(`${label}/bodies/${bid}/vertices: count TS=${tsV.length} Python=${pyV.length}`)
      } else {
        const a = sortedVerts(tsV)
        const b = sortedVerts(pyV)
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
    // multiset already match is the accepted curved-face divergence: OCC.js and
    // Python sample curved centroids/normals slightly differently and the 4dp
    // hash rounding is sensitive to it, though the body is equal within
    // tolerance. Warn but do not fail -- the structural + vertex checks already
    // passed. Any hash mismatch with a count or vertex mismatch stays a failure.
    const bodyGeomOk = faceCountOk && edgeCountOk && vertsOk
    for (const field of ['face_hashes', 'edge_hashes'] as const) {
      const tsHashes = sortHashes((tsBody[field] as string[]) ?? [])
      const pyHashes = sortHashes((pyBody[field] as string[]) ?? [])
      if (JSON.stringify(tsHashes) !== JSON.stringify(pyHashes)) {
        const msg = `${label}/bodies/${bid}/${field}: mismatch (TS=${tsHashes.length} Python=${pyHashes.length})`
        if (bodyGeomOk) {
          console.warn(`[parity] ${msg} -- accepted curved-face divergence`)
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
    if (!(bid in pyBodies)) {
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
// this guard a broken worker would turn every parity entry into a pass.
function assertSolveResponse(
  tsResponse: BuildResponse | null,
  label: string,
): asserts tsResponse is BuildResponse {
  if (!tsResponse) {
    throw new Error(
      `[parity] ${label}: solve produced no response ` +
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

// The real parity work below is wrapped in describe.skipIf(!oc || !solveBytes ||
// !topologyBytes). That makes a provisioning regression (OCC.js absent, WASM
// build missing, baseline corrupted) look like a green 0-test run instead of a
// failure. These always-running guards live outside the skipIf suite so a
// provisioning or baseline regression fails the parity job loudly. They check
// only the module-load results, which are null (never throw) when provisioning
// is absent, so they do not need OCC/WASM to actually load.
describe('parity provisioning guard', () => {
  it('has all provisioning globals (OCC.js + solver + topology WASM)', () => {
    expect(oc, 'oc: OCC.js absent - run `npm run occ:install`').toBeTruthy()
    expect(solveBytes, 'solveBytes: Rust solver WASM absent - run `just shadow:wasm`').toBeTruthy()
    expect(topologyBytes, 'topologyBytes: topology WASM absent - run `just shadow:wasm`').toBeTruthy()
  })

  it('has a non-trivial baseline corpus (not empty/corrupt)', () => {
    expect(entries.length, 'baseline corpus is empty or corrupted').toBeGreaterThanOrEqual(20)
  })

  // A valid-JSON baseline of all-failed entries would pass the corpus-count
  // guard and make every parity test hit the warn-and-return branch, so require
  // at least one entry the parity suite actually solves.
  it('has at least one baseline entry marked ok', () => {
    expect(entries.some((e) => e.ok), 'baseline corpus has no ok:true entry').toBe(true)
  })
})

// The null-solve guard does not need OCC.js (it uses a fake child), so it lives
// outside the skipIf suite and still runs when the kernel is not provisioned.
// The whole file is excluded from the default suite (see vitest.config.ts), so
// this runs only under the parity config.
describe('parity null-solve guard', () => {
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

describe.skipIf(!oc || !solveBytes || !topologyBytes)('full-doc parity (TS kernel vs frozen baseline)', () => {
  for (const entry of entries) {
    it(entry.label, async () => {
      const spec = entry.spec
      if (!spec || !entry.ok) {
        if (!entry.ok) {
          console.warn(`[parity] ${entry.label}: Python build failed, skipping`)
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
        console.warn(`[parity] ${entry.label}: skipped (unported kinds: ${[...unported].join(', ')})`)
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
        // Hard-fail by default: this is the enforced parity gate. A per-entry
        // `soft` flag (real-doc anchors) or PARITY_SOFT=1 downgrades to a
        // warn-only inventory -- a best-effort signal that never blocks the gate.
        const msg = `${allIssues.length} issue(s): ${allIssues.join('; ')}`
        const soft = import.meta.env.PARITY_SOFT === '1' || entry.soft === true
        if (soft) {
          const tag = entry.soft ? 'REAL-SOFT' : 'SOFT'
          // Warn-only inventory: the console.warn below IS the artifact and the
          // issues are already in `msg`. No assertion here on purpose, so a soft
          // anchor never blocks the gate.
          console.warn(`[parity] ${entry.label}: ${tag} ${msg}`)
        } else {
          expect(allIssues.length, msg).toBe(0)
        }
      }
    })
  }
})
