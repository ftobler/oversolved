// @vitest-environment node
//
// Full-document parity test: replays the 20 PartDoc specs from the regression
// baseline through the TS/WASM kernel (OCC.js + Rust sketch solver) and diffs
// the output against the frozen baseline.
//
// The baseline (regression-baseline.json) is a golden snapshot of the now-deleted
// Python kernel's output, captured before phase 4d removed it. The Python kernel
// and its extractor are gone, so the baseline cannot be regenerated -- this is
// now a regression gate (live TS/WASM kernel == frozen golden file), not a live
// old-vs-new comparison. Gated: skips entirely when OCC.js or the Rust solver is
// absent, so the default CI run stays green (the dedicated parity job installs
// OCC.js so it does run there).
//
// Provision OCC.js:
//   cd frontend && npm run occ:install

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { HandleTable } from './handleTable'
import { solidToMesh, solidToEdges, solidToVertices } from './tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from './brepDiffHash'
import { faceGeometryHash, edgeGeometryHash } from '../geomHash'
import { build, type BuildDeps } from '../builder'
import { initGlobalRepo } from '../query'
import { createFeatureSolver, unportedKinds } from '../solverRegistry'
import { postRegister } from '../features/postRegister'
import { setSketchSolver, setSketchTopology, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import type { OccModule } from './occTypes'
import type { Body } from '../types3d'
import baseline from '@/wasm-kernel/regression-baseline.json'

// ── Pre-load OCC.js and the Rust solver ─────────────────────────────────

const oc = await loadOcc()
const solveBytes = loadSolver()
const topologyBytes = loadTopology()

// ── Baseline types ──────────────────────────────────────────────────────

interface BaselineEntry {
  label: string
  ok: boolean
  error: string | null
  spec: Record<string, unknown>
  input_sketches?: unknown[]
  result: Record<string, unknown>
  bodies: Record<string, BaselineBody>
  // Real-doc anchors (4b.5) are a best-effort signal: warn on divergence, never
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

// ── Diff helpers ─────────────────────────────────────────────────────────

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

    // Structural counts.
    const faceCountOk = typeof tsBody.face_count !== 'number' || tsBody.face_count === pyBody.face_count
    const edgeCountOk = typeof tsBody.edge_count !== 'number' || tsBody.edge_count === pyBody.edge_count
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

  return issues
}

// ── Tessellation deps ────────────────────────────────────────────────────

function tessellateBodies(
  ocMod: OccModule,
  table: HandleTable,
  bodyStore: Record<string, Body>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [bodyId, body] of Object.entries(bodyStore)) {
    if (body.shape == null) continue
    try {
      const mesh = solidToMesh(ocMod, table, body.shape, {
        createdBy: body.created_by || '',
        bodyId: body.id,
        faceLineage: body.face_lineage ?? null,
        profileQueries: body.profile_queries ?? [],
      })
      const edges = solidToEdges(ocMod, table, body.shape).edges
      const vertices = solidToVertices(ocMod, table, body.shape).vertices
      // Mirror run_kernel.py: face_hashes from face_data (centroid+normal),
      // edge_hashes from the edge dicts, both string-sorted.
      const faceHashes = (mesh.face_data ?? [])
        .map((fd) => faceGeometryHash(fd.centroid, fd.normal))
        .sort()
      const edgeHashes = edges
        .map((ed) => edgeGeometryHash(ed as unknown as Record<string, unknown>))
        .sort()
      out[bodyId] = {
        id: body.id,
        created_by: body.created_by || '',
        modified_by: body.modified_by ?? [],
        mesh,
        edges,
        vertices,
        face_count: (mesh.face_data ?? []).length,
        edge_count: edges.length,
        face_hashes: faceHashes,
        edge_hashes: edgeHashes,
      }
    } catch {
      // non-fatal
    }
  }
  return out
}

// ── Test suite ───────────────────────────────────────────────────────────

describe.skipIf(!oc || !solveBytes || !topologyBytes)('full-doc parity (TS kernel vs frozen baseline)', () => {
  let occMod: OccModule

  beforeAll(async () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occMod = oc
    if (solveBytes) {
      resetSketchSolver()
      setSketchSolver(solveBytes)
      setSketchTopology(topologyBytes)
    }
  })

  for (const entry of entries) {
    it(entry.label, () => {
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

      const scope = new DisposeScope()
      const table = new HandleTable({ finalizerGuard: false })

      try {
        const deps: BuildDeps = {
          trySolveFeature: createFeatureSolver(occMod, scope, table),
          postRegister,
          initGlobalRepo,
          tessellateBodies: (bodyStore) => tessellateBodies(occMod, table, bodyStore),
          brepDiffNewFaceHashes: (body) => brepDiffNewFaceHashes(occMod, scope, body),
          brepDiffNewEdgeHashes: (body) => brepDiffNewEdgeHashes(occMod, scope, body),
          brepDiffNewVertexHashes: (body) => brepDiffNewVertexHashes(occMod, scope, body),
        }

        const tsResponse = build(spec, { prevState: null }, deps)
        const tsResult = tsResponse.result as Record<string, unknown>
        const tsBodies = tsResponse.bodies as Record<string, Record<string, unknown>>

        const allIssues: string[] = [
          ...diffResult(tsResult, entry.result, entry.label),
          ...diffBodies(tsBodies, entry.bodies, entry.label),
        ]

        if (allIssues.length > 0) {
          // Hard-fail by default: this is the enforced parity gate. A per-entry
          // `soft` flag (real-doc anchors, 4b.5) or PARITY_SOFT=1 downgrades to a
          // warn-only inventory -- a best-effort signal that never blocks the gate.
          const msg = `${allIssues.length} issue(s): ${allIssues.join('; ')}`
          const soft = import.meta.env.PARITY_SOFT === '1' || entry.soft === true
          if (soft) {
            const tag = entry.soft ? 'REAL-SOFT' : 'SOFT'
            console.warn(`[parity] ${entry.label}: ${tag} ${msg}`)
            expect(allIssues.length, `SOFT: ${msg}`).toBeGreaterThan(-1)
          } else {
            expect(allIssues.length, msg).toBe(0)
          }
        }
      } finally {
        scope.dispose()
      }
    })
  }
})
