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
function topFaceQuery(bodies: Record<string, unknown>): string {
  const body = Object.values(bodies)[0] as { mesh?: { face_queries?: string[]; face_edge_queries?: string[][] } }
  const queries = body?.mesh?.face_queries ?? []
  const boundaries = body?.mesh?.face_edge_queries ?? []
  const hit = queries.findIndex((q, i) => q.includes('cls_zp') && (boundaries[i]?.length ?? 0) === 4)
  if (hit < 0) throw new Error(`no top-cap query among ${queries.length} face queries`)
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
})
