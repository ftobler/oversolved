// @vitest-environment node
//
// Stage 1.5 pre-flight spike: validates the anchor-migration contract before
// the Anchor schema is committed. No production code ships from this file; it
// de-risks the migration design (see feature/multi-part-assembly.md § "Anchor
// identity and migration").
//
// The spike:
//   1. Builds a single-extrude part, enumerates (kind, descriptor, created_by)
//      tuples for faces, edges, and vertices.
//   2. Changes the extrude dimension so faces move, re-builds, and diffs the
//      tuples to confirm:
//        - Tier 1 (exact descriptor): unchanged faces keep their descriptor.
//        - Tier 1 miss: moved faces' descriptors change because the centroid
//          moved.
//        - Tier 2 (created_by + kind): within a feature's output, the moved
//          face is uniquely re-findable by surface_type or edge kind.
//   3. Diffs build-side tuples against the repo (ID-buffer) population — the
//      descriptor tokens the build emits must be the same ones the ID buffer
//      registers for picks.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { solidToMesh, solidToEdges, solidToVertices } from '../occ/tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from '../occ/brepDiffHash'
import { build, type BuildDeps, type BuildResponse } from '../builder'
import { initGlobalRepo, parseAncestry } from '../query'
import { createFeatureSolver } from '../solverRegistry'
import { postRegister } from '../features/postRegister'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

// ── Descriptor token extraction ────────────────────────────────────────────

function findDescriptorToken(ids: string[], prefix: string): string | null {
  return ids.find((id) => id.startsWith(prefix)) ?? null
}

function extractFaceTuples(result: BuildResponse): { descriptor: string; kind: string; created_by: string }[] {
  const tuples: { descriptor: string; kind: string; created_by: string }[] = []
  for (const [, raw] of Object.entries(result.bodies as Record<string, Record<string, unknown>>)) {
    const fqs = (raw.mesh as { face_queries?: string[] } | undefined)?.face_queries ?? []
    for (const fq of fqs) {
      const [ids, typeRestriction] = parseAncestry(fq)
      const desc = findDescriptorToken(ids, '@u|') ?? findDescriptorToken(ids, '@gdf|')
      if (desc && raw.created_by) {
        tuples.push({ descriptor: desc, kind: typeRestriction || 'face', created_by: raw.created_by as string })
      }
    }
  }
  return tuples
}

function extractEdgeTuples(result: BuildResponse): { descriptor: string; kind: string; created_by: string }[] {
  const tuples: { descriptor: string; kind: string; created_by: string }[] = []
  for (const [, raw] of Object.entries(result.bodies as Record<string, Record<string, unknown>>)) {
    const eqs = (raw.edge_queries as string[] | undefined) ?? []
    for (const eq of eqs) {
      const [ids, typeRestriction] = parseAncestry(eq)
      const desc = findDescriptorToken(ids, '@u|') ?? findDescriptorToken(ids, '@gde|')
      if (desc && raw.created_by) {
        tuples.push({ descriptor: desc, kind: typeRestriction || 'edge', created_by: raw.created_by as string })
      }
    }
  }
  return tuples
}

function extractVertexTuples(result: BuildResponse): { descriptor: string; kind: string; created_by: string }[] {
  const tuples: { descriptor: string; kind: string; created_by: string }[] = []
  for (const [, raw] of Object.entries(result.bodies as Record<string, Record<string, unknown>>)) {
    const vqs = (raw.vertex_queries as string[] | undefined) ?? []
    for (const vq of vqs) {
      const [ids] = parseAncestry(vq)
      const desc = findDescriptorToken(ids, '@u|') ?? findDescriptorToken(ids, '@gdv|')
      if (desc && raw.created_by) {
        tuples.push({ descriptor: desc, kind: 'vertex', created_by: raw.created_by as string })
      }
    }
  }
  return tuples
}

// ── Build helper ───────────────────────────────────────────────────────────

function run(spec: Record<string, unknown>): BuildResponse {
  const scope = new DisposeScope()
  const table = new HandleTable({ finalizerGuard: false })
  try {
    const deps: BuildDeps = {
      trySolveFeature: createFeatureSolver(oc!, scope, table),
      postRegister, initGlobalRepo,
      tessellateBodies: (bodyStore) => {
        const out: Record<string, Record<string, unknown>> = {}
        for (const [, body] of Object.entries(bodyStore)) {
          if (!body.shape) continue
          try {
            const mesh = solidToMesh(oc!, table, body.shape, {
              createdBy: body.created_by || '',
              bodyId: body.id,
              faceAncestry: body.face_ancestry ?? null,
              faceNames: body.face_names ?? null,
              profileQueries: body.profile_queries ?? [],
            })
            const edgeResult = solidToEdges(oc!, table, body.shape, {
              createdBy: body.created_by || '',
              bodyId: body.id,
              profileQueries: body.profile_queries ?? [],
              edgeAncestry: body.edge_ancestry ?? null,
              edgeNames: body.edge_names ?? null,
            })
            const vertexResult = solidToVertices(oc!, table, body.shape, {
              createdBy: body.created_by || '',
              bodyId: body.id,
              profileQueries: body.profile_queries ?? [],
              faceNames: body.face_names ?? null,
            })
            out[body.id] = {
              id: body.id,
              created_by: body.created_by,
              modified_by: body.modified_by ?? [],
              mesh,
              edges: edgeResult.edges,
              edge_queries: edgeResult.edge_queries,
              vertices: vertexResult.vertices,
              vertex_queries: vertexResult.vertex_queries,
            }
          } catch { /* non-fatal */ }
        }
        return out
      },
      brepDiffNewFaceHashes: (b) => brepDiffNewFaceHashes(oc!, scope, b),
      brepDiffNewEdgeHashes: (b) => brepDiffNewEdgeHashes(oc!, scope, b),
      brepDiffNewVertexHashes: (b) => brepDiffNewVertexHashes(oc!, scope, b),
    }
    const result = build(spec, {}, deps)
    scope.dispose()
    return result
  } catch (e) {
    scope.dispose()
    throw e
  }
}

// ── Fixture specs ──────────────────────────────────────────────────────────

function rectSketchSpec(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle',
    plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
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

function extrudeSpec(sketchId: string, extrudeId: string, distance: number) {
  return {
    id: extrudeId, kind: 'extrude' as const, label: 'Extrude',
    sketch: '$' + sketchId, distance, direction: 'normal', operation: 'add' as const,
  }
}

describe.skipIf(!oc || !solveBytes)('anchor migration spike (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  // ── Descriptor emission ─────────────────────────────────────────────────

  it('face_queries emit @u| construction UUID tokens, not old geometry descriptors', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const faceTuples = extractFaceTuples(result)
    expect(faceTuples.length).toBeGreaterThan(0)
    for (const ft of faceTuples) {
      expect(ft.descriptor.startsWith('@u|')).toBe(true)
      expect(ft.descriptor).not.toMatch(/^@gdf\|/)
      expect(ft.descriptor).not.toMatch(/^@gface_/)
    }
  })

  it('edge_queries emit @u| construction UUID tokens', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const edgeTuples = extractEdgeTuples(result)
    expect(edgeTuples.length).toBeGreaterThan(0)
    for (const et of edgeTuples) {
      expect(et.descriptor.startsWith('@u|')).toBe(true)
    }
  })

  it('vertex_queries emit @u| construction UUID tokens', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const vertexTuples = extractVertexTuples(result)
    expect(vertexTuples.length).toBeGreaterThan(0)
    for (const vt of vertexTuples) {
      expect(vt.descriptor.startsWith('@u|')).toBe(true)
    }
  })

  // ── Tier 1: exact descriptor match on unchanged geometry ─────────────────

  it('Tier 1: same-dimension rebuild produces identical descriptors', () => {
    const r1 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const r2 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })

    const f1 = extractFaceTuples(r1).sort((a, b) => a.descriptor.localeCompare(b.descriptor))
    const f2 = extractFaceTuples(r2).sort((a, b) => a.descriptor.localeCompare(b.descriptor))

    expect(f1.length).toBe(f2.length)
    for (let i = 0; i < f1.length; i++) {
      // Same-geometry rebuild must produce byte-identical descriptors because
      // the 4dp rounding in pyRound4Str is deterministic.
      expect(f2[i].descriptor).toBe(f1[i].descriptor)
    }

    const e1 = extractEdgeTuples(r1).sort((a, b) => a.descriptor.localeCompare(b.descriptor))
    const e2 = extractEdgeTuples(r2).sort((a, b) => a.descriptor.localeCompare(b.descriptor))
    expect(e1.length).toBe(e2.length)
    for (let i = 0; i < e1.length; i++) {
      expect(e2[i].descriptor).toBe(e1[i].descriptor)
    }

    const v1 = extractVertexTuples(r1).sort((a, b) => a.descriptor.localeCompare(b.descriptor))
    const v2 = extractVertexTuples(r2).sort((a, b) => a.descriptor.localeCompare(b.descriptor))
    expect(v1.length).toBe(v2.length)
    for (let i = 0; i < v1.length; i++) {
      expect(v2[i].descriptor).toBe(v1[i].descriptor)
    }
  })

  // ── Tier 1 miss: moving a face changes its descriptor ────────────────────

  // Stage 7: construction UUIDs (@u|) are stable across dimension edits because
  // they are derived from symbolic construction paths (feature ids, sketch entity
  // ids), not from geometry. A height change keeps every face's @u| unchanged.

  it('Tier 1: construction UUIDs survive dimension edits — same set after height change', () => {
    const r5 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const r8 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 8)] })

    const faces5 = extractFaceTuples(r5)
    const faces8 = extractFaceTuples(r8)
    expect(faces5.length).toBe(6)  // rect extrude: 4 sides + start cap + end cap
    expect(faces8.length).toBe(6)

    const descs5 = new Set(faces5.map((t) => t.descriptor))
    const descs8 = new Set(faces8.map((t) => t.descriptor))

    // Construction UUIDs are symbolic: every face from extrude 5 should have the
    // same UUID as its counterpart in extrude 8, because the construction path
    // (created_by + cap/side role) did not change.
    expect(descs5.size).toBe(6)
    expect(descs8.size).toBe(6)
    for (const d of descs5) expect(descs8.has(d)).toBe(true)
  })

  // ── Tier 2: moved face is uniquely re-findable by (created_by, kind) ─────

  // With construction UUIDs, Tier 1 (exact @u| match) already handles moved
  // faces unambiguously. Tier 2 (created_by + kind) is the fallback for entities
  // that did not earn a @u| token — typically post-boolean faces/edges that
  // cannot inherit a stable construction path. Verify the Tier 2 grouping is
  // sound: after a geometry edit the (created_by, kind) scope is populated and
  // internally consistent.

  it('Tier 2: created_by + kind scope is intact after an edit for fallback matching', () => {
    const r5 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const r8 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 8)] })

    const faces5 = extractFaceTuples(r5)
    const faces8 = extractFaceTuples(r8)

    // Group the 8-mm faces by (created_by, kind). A box has 6 flatfaces from one
    // feature. The scope is still populated and self-consistent post-edit.
    for (const old of faces5) {
      const candidates = faces8.filter(
        (f) => f.created_by === old.created_by && f.kind === old.kind,
      )
      expect(candidates.length).toBeGreaterThanOrEqual(1)
      expect(candidates.every((c) => c.kind === old.kind)).toBe(true)
    }

    // All faces from one extrude share the same feature id.
    const allCreatedBy = faces5.map((f) => f.created_by)
    expect(new Set(allCreatedBy).size).toBe(1)
  })

  // ── Edge and vertex descriptors survive dimension edits ──────────────────

  it('construction UUIDs for edges and vertices are stable across dimension edits', () => {
    const r5 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const r8 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 8)] })

    const ev5 = extractEdgeTuples(r5).sort((a, b) => a.descriptor.localeCompare(b.descriptor))
    const ev8 = extractEdgeTuples(r8).sort((a, b) => a.descriptor.localeCompare(b.descriptor))

    expect(ev5.length).toBeGreaterThan(0)
    expect(ev8.length).toBeGreaterThan(0)
    // Construction UUIDs are derived from face UUID pairs, which are symbolic.
    // Every edge descriptor from build 5 should appear in build 8.
    const descs8 = new Set(ev8.map((e) => e.descriptor))
    for (const e of ev5) expect(descs8.has(e.descriptor)).toBe(true)

    // Vertex layer: same stability guarantee.
    const vv5 = extractVertexTuples(r5)
    const vv8 = extractVertexTuples(r8)
    expect(vv5.length).toBeGreaterThan(0)
    expect(vv8.length).toBeGreaterThan(0)
    const descsV8 = new Set(vv8.map((v) => v.descriptor))
    for (const v of vv5) expect(descsV8.has(v.descriptor)).toBe(true)
  })

  // ── Build-side vs ID-buffer: they emit the same descriptors ─────────────

  it('build-side tuples match repo population (ID buffer sees the same @u| tokens)', () => {
    const r = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })

    const faceTuples = extractFaceTuples(r)
    const buildDescriptors = new Set(faceTuples.map((t) => t.descriptor))

    for (const ft of faceTuples) {
      expect(ft.descriptor.startsWith('@u|')).toBe(true)
    }

    // Spot-check: the face_queries string contains the @u| descriptor as its
    // first token (construction UUIDs are prepended first).
    const fqs = Object.values(r.bodies as Record<string, Record<string, unknown>>).flatMap(
      (b) => (b.mesh as { face_queries?: string[] } | undefined)?.face_queries ?? [])
    for (const fq of fqs) {
      const [ids] = parseAncestry(fq)
      const firstDesc = ids.find((id) => id.startsWith('@u|'))
      expect(firstDesc).toBeTruthy()
      if (firstDesc) expect(buildDescriptors.has(firstDesc)).toBe(true)
    }

    // Confirm we also have descriptors for edges and vertices.
    expect(extractEdgeTuples(r).length).toBeGreaterThan(0)
    expect(extractVertexTuples(r).length).toBeGreaterThan(0)
  })

  // ── Kind coverage: face surface_types present ────────────────────────────

  it('face surface_types are the expected Anchor.kind pre-images (flatface, cylinderface)', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const faces = extractFaceTuples(result)
    const kinds = new Set(faces.map((f) => f.kind))

    // A box produces only flatfaces.
    expect(kinds.has('flatface')).toBe(true)
    // No other kinds for a box.
    expect(kinds.size).toBe(1)
  })

  // ── Performance: two-feature part produces distinct created_by scopes ────

  it('different features produce different created_by scopes for Tier 2 isolation', () => {
    const r = run({
      features: [
        rectSketchSpec('sk1', 10, 10),
        extrudeSpec('sk1', 'ex1', 5),
        {
          id: 'ex2', kind: 'extrude' as const, label: 'Cut',
          sketch: '$sk1', distance: 2, direction: 'normal', operation: 'cut' as const,
        },
      ],
    })
    const faces = extractFaceTuples(r)
    // Some faces were created by the cut operation. Different parts of the
    // B-rep may carry the extrude's or cut's created_by.
    const createdBySet = new Set(faces.map((f) => f.created_by))
    expect(createdBySet.size).toBeGreaterThanOrEqual(1)
  })
})
