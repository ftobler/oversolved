// @vitest-environment node
//
// Full-document shell test through the production builder: a refused shell (a
// thickness past the local radius) must not abort the solve. The builder catches
// each feature's exception and continues, so a downstream feature still runs on
// the unchanged body. Mirrors the "the solve continues for downstream features"
// item the shell leaf test cannot reach (it calls solveShell directly).
//
// The top-cap pick is read off a first base solve, so the recipe does not hard
// code a construction UUID.
//
// Skips when OCC.js or the Rust sketch-solver WASM is absent, like every *Real
// suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { setSolveLocalsForTest, solveLocally } from '../../solveLocally'
import { partSpecFromText } from '@/utils/partExport'
import { readSolveOutcomes, featureProblems, blocksExport } from '@/drive/featureOutcome'
import type { PartDoc } from '@/types/cad'
import type { OccModule } from '../../occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()
const ready = oc !== null && solveBytes !== null

// A 10x10x5 box: the base every shell case builds on.
const BASE_RECIPE = `
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: bottom
        kind: line
      - id: right
        kind: line
      - id: top
        kind: line
      - id: left
        kind: line
    initial:
      bottom: [0, 0, 10, 0]
      right: [10, 0, 10, 10]
      top: [10, 10, 0, 10]
      left: [0, 10, 0, 0]
    constraints:
      - { id: c1, kind: coincident, a: { entity: bottom, point: end }, b: { entity: right, point: start } }
      - { id: c2, kind: coincident, a: { entity: right, point: end }, b: { entity: top, point: start } }
      - { id: c3, kind: coincident, a: { entity: top, point: end }, b: { entity: left, point: start } }
      - { id: c4, kind: coincident, a: { entity: left, point: end }, b: { entity: bottom, point: start } }
      - { id: c5, kind: horizontal, target: { entity: bottom } }
      - { id: c6, kind: horizontal, target: { entity: top } }
      - { id: c7, kind: vertical, target: { entity: right } }
      - { id: c8, kind: vertical, target: { entity: left } }
      - { id: c9, kind: length, target: { entity: bottom }, value: 10 }
      - { id: c10, kind: length, target: { entity: left }, value: 10 }
  - id: ex1
    kind: extrude
    extrude:
      sketch: $sk1
      distance: 5
      direction: normal
      operation: new
`

/** The query of the box's top cap (the 4-edge face whose classifier is +z). */
function topFaceEntry(bodies: Record<string, unknown>): { query: string; edges: string[] } {
  const body = Object.values(bodies)[0] as { mesh?: { face_queries?: string[]; face_edge_queries?: string[][] } }
  const queries = body?.mesh?.face_queries ?? []
  const boundaries = body?.mesh?.face_edge_queries ?? []
  const hit = queries.findIndex((q, i) => q.includes('cls_zp') && (boundaries[i]?.length ?? 0) === 4)
  if (hit < 0) throw new Error(`no top-cap query among ${queries.length} face queries`)
  return { query: queries[hit], edges: boundaries[hit] ?? [] }
}

function topFaceQuery(bodies: Record<string, unknown>): string {
  return topFaceEntry(bodies).query
}

/**
 * The 2026-11-12 report document: the 10 x 10 x 5 plate of BASE_RECIPE plus a
 * D10 boss 1 high above its top face, so the boss wall is tangent to all four
 * plate sides. The boss sketch sits on a plane offset 4 from Front and extrudes
 * 2, so it overlaps the plate by 1 and leaves a 1-high boss.
 */
const REPORT_RECIPE = BASE_RECIPE + `
  - id: pl1
    kind: plane
    definition: { mode: offset, plane: "@builtin_plane_front", offset: 4 }
  - id: sk2
    kind: sketch
    plane: "@pl1"
    entities:
      - id: circ
        kind: circle
    initial:
      circ: [5, 5, 5]
    constraints:
      - { id: c20, kind: diameter, target: { entity: circ }, value: 10 }
  - id: ex2
    kind: extrude
    extrude:
      sketch: $sk2
      distance: 2
      direction: normal
      operation: add
`

/** The boss top disc: the one +z face whose boundary is a single circle. */
function bossTopQuery(bodies: Record<string, unknown>): string {
  const body = Object.values(bodies)[0] as { mesh?: { face_queries?: string[]; face_edge_queries?: string[][] } }
  const queries = body?.mesh?.face_queries ?? []
  const boundaries = body?.mesh?.face_edge_queries ?? []
  const hit = queries.findIndex((q, i) => q.includes('cls_zp') && (boundaries[i]?.length ?? 0) === 1)
  if (hit < 0) throw new Error(`no boss top query among ${queries.length} face queries`)
  return queries[hit]
}

describe.skipIf(!ready)('shell full-document continuation (real kernel)', () => {
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc as OccModule)
  })

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('a refused shell leaves the body for the next feature to build on', { timeout: 120_000 }, async () => {
    const base = partSpecFromText(BASE_RECIPE)
    base.id = 'shell-doc-base'
    const baseResponse = await solveLocally(base, { prevState: null })
    expect(baseResponse).not.toBeNull()
    const top = topFaceQuery(baseResponse!.bodies)

    const features = [...(base.features as Record<string, unknown>[])]
    // Thickness 6 past the local radius: the kernel refuses and the builder
    // records an exception, not a thrown solve.
    features.push({ id: 'sh1', kind: 'shell', shell: { faces: [top], thickness: 6 } })
    // The next feature must still run, on the untouched 10x10x5 body.
    features.push({ id: 'sh2', kind: 'shell', shell: { faces: [top], thickness: 1 } })
    const response = await solveLocally({ ...base, id: 'shell-doc-continuation', features }, { prevState: null })
    expect(response).not.toBeNull()
    const result = response!.result as Record<string, { status?: string }>
    expect(result.sh1.status).toBe('exception')
    expect(result.sh2.status).toBe('ok')
  })

  it('opens a filleted top face in both directions', { timeout: 120_000 }, async () => {
    // The key_cap repro: the removed top face is bounded by four r1 fillets.
    // OCC's sharp-join thick solid refuses that shape (build_not_done inward,
    // build_failed outward); the arc-join fallback must produce the hollow open
    // box instead of leaving the body unchanged.
    const base = partSpecFromText(BASE_RECIPE)
    base.id = 'shell-doc-fillet-base'
    const baseResponse = await solveLocally(base, { prevState: null })
    expect(baseResponse).not.toBeNull()
    const top = topFaceEntry(baseResponse!.bodies)
    expect(top.edges).toHaveLength(4)

    for (const direction of ['inward', 'outward']) {
      const features = [...(base.features as Record<string, unknown>[])]
      features.push({ id: 'fi1', kind: 'fillet', fillet: { edges: top.edges, radius: 1 } })
      features.push({ id: 'sh1', kind: 'shell', shell: { faces: [top.query], thickness: 0.75, direction } })
      const response = await solveLocally(
        { ...base, id: `shell-doc-fillet-${direction}`, features },
        { prevState: null },
      )
      expect(response).not.toBeNull()
      const result = response!.result as Record<string, { status?: string }>
      expect(result.fi1.status).toBe('ok')
      expect(result.sh1.status).toBe('ok')
      expect(Object.keys(response!.bodies)).toHaveLength(1)
    }
  })

  it('a report body sharp shell reaches the drive outcome as a warning', { timeout: 120_000 }, async () => {
    // The report document: plate + inscribed D10 boss, the boss top opened at
    // 0.5 with no `join` key. The sharp join refuses and the kernel builds arc;
    // readSolveOutcomes is where the drive boundary turns that into the warning
    // row the MCP reply lists under `features`.
    const base = partSpecFromText(REPORT_RECIPE)
    base.id = 'shell-doc-report'
    const baseResponse = await solveLocally(base, { prevState: null })
    expect(baseResponse).not.toBeNull()
    // The boss fused into the plate: one body, and the boss top exists.
    expect(Object.keys(baseResponse!.bodies)).toHaveLength(1)
    const bossTop = bossTopQuery(baseResponse!.bodies)

    const features = [...(base.features as Record<string, unknown>[])]
    features.push({ id: 'sh1', kind: 'shell', shell: { faces: [bossTop], thickness: 0.5 } })
    const response = await solveLocally({ ...base, id: 'shell-doc-report-shell', features }, { prevState: null })
    expect(response).not.toBeNull()
    const outcomes = readSolveOutcomes(response!.result as never)
    expect(outcomes.sh1.status).toBe('ok')
    expect(outcomes.sh1.warning).toMatch(/the sharp join was refused/)
    expect(outcomes.sh1.note).toBeUndefined()
    // The drive lists the built-but-substituted shell under `features`, and the
    // exported file stays ok because the solid is valid.
    const doc = { ...base, features } as unknown as PartDoc
    const problems = featureProblems(doc, outcomes)
    expect(problems.map(p => p.id)).toContain('sh1')
    expect(blocksExport(problems.find(p => p.id === 'sh1')!)).toBe(false)
  })
})
