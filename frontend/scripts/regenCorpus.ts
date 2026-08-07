// Regenerate the full-doc parity corpus: solves the projection corpus (plus the
// two array specs whose format drifted from the now-deleted Python kernel)
// through the live TS/WASM kernel and writes the frozen golden entries to
// scripts/corpus-regen.json. Run scripts/mergeCorpus.py afterwards to merge that
// payload into regression-baseline.json + corpus-manifest.json in the original
// Python json format (so unchanged entries round-trip byte-identically and a
// regen diffs only the real data changes).
//
// The Python kernel is gone, so this is NOT a cross-kernel diff: the baseline is
// a self-consistent golden of the current TS kernel (a regression gate that
// guards the projection path against future drift). It is the modern successor
// to the deleted tests/wasm_harness/corpus.py + extract_fixtures.py.
//
// Run from frontend/:
//   npm run regen:corpus   # node solve step, then the python merge step
// (OCC.js + the Rust solver must be provisioned; see `just parity`.)

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { solveWithTimeout, disposeWorker } from '../src/kernel/solveTimeout'
import { buildBaselineBody } from '../src/wasm-kernel/parityBaseline'
import type { EdgeData } from '../src/types/cad'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PAYLOAD_PATH = path.resolve(__dirname, 'corpus-regen.json')

// ─── Spec builders ───

type Dict = Record<string, unknown>

function partSpec(features: unknown[]): Dict {
  return { kind: 'part', version: 1, features }
}

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front'): Dict {
  return {
    id: sketchId, kind: 'sketch', label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: h },
    ],
  }
}

function circleSketch(sketchId: string, radius: number, plane = '@builtin_plane_front'): Dict {
  return {
    id: sketchId, kind: 'sketch', label: 'Circle', plane,
    entities: [{ id: 'c1', kind: 'circle' }],
    initial: { c1: [0, 0, radius] },
    constraints: [
      { id: 'c_coin', kind: 'coincident', a: { entity: 'c1', point: 'center' }, b: '@builtin_origin' },
      { id: 'c_dia', kind: 'diameter', target: { entity: 'c1' }, value: radius * 2 },
    ],
  }
}

function extrude(fid: string, sketchId: string, distance: number): Dict {
  return { id: fid, kind: 'extrude', sketch: `$${sketchId}`, distance, direction: 'normal', operation: 'add' }
}

function lineDirectionSketch(): Dict {
  return {
    id: 'sk_dir', kind: 'sketch', label: 'Directions', plane: '@builtin_plane_front',
    entities: [{ id: 'lx', kind: 'line' }, { id: 'ly', kind: 'line' }],
    initial: { lx: [0, 0, 1, 0], ly: [0, 0, 0, 1] },
    constraints: [],
  }
}

function projectedSketch(
  sketchId: string,
  plane: string,
  entities: Array<{ id: string; kind: string; source: string }>,
): Dict {
  return { id: sketchId, kind: 'sketch', label: 'Projected', plane, entities, initial: {}, constraints: [] }
}

// ─── Query selection ───

interface BodyOutput {
  edges?: EdgeData[]
  edge_queries?: string[]
  mesh?: { face_queries?: string[]; face_edge_queries?: string[][] }
}

/** An edge query whose geometry is a full circle. */
function pickCircleEdgeQuery(body: BodyOutput): string {
  const edges = body.edges ?? []
  const queries = body.edge_queries ?? []
  for (let i = 0; i < edges.length; i++) {
    if (edges[i].kind === 'circle') return queries[i]
  }
  throw new Error('no circular edge query found')
}

/** An edge query whose query string contains every token (profile/classifier). */
function pickEdgeQuery(body: BodyOutput, tokens: string[]): string {
  const queries = body.edge_queries ?? []
  const hit = queries.find((q) => tokens.every((t) => q.includes(t)))
  if (!hit) throw new Error(`no edge query containing ${tokens.join('+')} (have ${queries.length} queries)`)
  return hit
}

/** The front (z=-) face's boundary edge queries. */
function pickFrontFaceBoundary(body: BodyOutput): string[] {
  const faceQueries = body.mesh?.face_queries ?? []
  const boundaries = body.mesh?.face_edge_queries ?? []
  const candidates = faceQueries
    .map((fq, i) => ({ fq, boundary: boundaries[i] ?? [] }))
    .filter((c) => c.fq.includes('cls_zn') && c.boundary.length === 4)
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one front face, found ${candidates.length}`)
  }
  return candidates[0].boundary
}

// ─── Corpus cases ───

interface ProjectionCase {
  label: string
  feature_kind: string
  query_tier: string
  spec: Dict
}

const projectionCases: ProjectionCase[] = []
const warn: string[] = []

async function addProjectionCase(
  label: string,
  baseSpec: Dict,
  buildProjection: (body: BodyOutput) => Array<{ id: string; kind: string; source: string }>,
  buildExtra?: (body: BodyOutput) => Dict[],
  plane = '@builtin_plane_front',
  validate?: (result: Dict, body: BodyOutput) => void,
): Promise<void> {
  const base = await solveWithTimeout(baseSpec, { prevState: null })
  if (!base) throw new Error(`${label}: base solve returned null (OCC.js unavailable?)`)
  const body = (base.bodies as Record<string, BodyOutput>)[Object.keys(base.bodies as Record<string, unknown>)[0]]
  if (!body) throw new Error(`${label}: base solve produced no body`)
  const entities = buildProjection(body)
  const extraFeatures = buildExtra ? buildExtra(body) : []
  const fullSpec = partSpec([...(baseSpec.features as Dict[]), projectedSketch('sk2', plane, entities), ...extraFeatures])
  const solved = await solveWithTimeout(fullSpec, { prevState: null })
  if (!solved) throw new Error(`${label}: solve returned null`)
  const sk2 = (solved.result as Record<string, Dict>).sk2
  if (sk2.status === 'exception') throw new Error(`${label}: sk2 exception: ${JSON.stringify(sk2.exception)}`)
  const errors = (sk2.projection_errors as string[]) ?? []
  if (errors.length > 0) throw new Error(`${label}: projection errors: ${JSON.stringify(errors)}`)
  if (validate) validate(sk2, body)
  projectionCases.push({ label, feature_kind: 'project', query_tier: 'projection', spec: fullSpec })
}

function assertGeometry(sk2: Dict, entIds: string[]): void {
  const geom = (sk2.geometry as Record<string, number[]>) ?? {}
  for (const id of entIds) {
    const params = geom[id]
    if (!params) throw new Error(`projected entity ${id} has no geometry`)
    // A full zero/duplicate param set means the projection collapsed (degenerate).
    const first = params.slice(0, 4)
    if (first.every((v) => Math.abs(v) < 1e-9)) throw new Error(`projected entity ${id} is degenerate: ${JSON.stringify(params)}`)
  }
}

async function buildProjectionCases(): Promise<void> {
  // Case 1: a straight body edge projected onto the front plane -> a line.
  // Pinned to the bottom-front edge (profile bottom + y=0 + z=0) so a picker
  // heuristic change cannot silently swap which edge the corpus freezes.
  const boxBase = partSpec([rectSketch('sk1', 10, 10), extrude('ex1', 'sk1', 5)])
  await addProjectionCase(
    'project_straight_edge',
    boxBase,
    (body) => [{ id: 'proj0', kind: 'line', source: pickEdgeQuery(body, ['@sk1/bottom', 'cls_yn', 'cls_zn']) }],
    undefined, '@builtin_plane_front',
    (sk2) => assertGeometry(sk2, ['proj0']),
  )

  // Case 2: a planar face projected as a closed wire of its boundary edges.
  await addProjectionCase(
    'project_planar_face_wire',
    boxBase,
    (body) => pickFrontFaceBoundary(body).map((q, i) => ({ id: `proj${i}`, kind: 'line', source: q })),
    undefined, '@builtin_plane_front',
    (sk2) => assertGeometry(sk2, ['proj0', 'proj1', 'proj2', 'proj3']),
  )

  // Case 3: a circular body edge projected onto a plane parallel to it -> a circle.
  const cylBase = partSpec([circleSketch('sk1', 5), extrude('ex1', 'sk1', 5)])
  await addProjectionCase(
    'project_circular_edge',
    cylBase,
    (body) => [{ id: 'proj0', kind: 'circle', source: pickCircleEdgeQuery(body) }],
    undefined, '@builtin_plane_front',
    (sk2) => assertGeometry(sk2, ['proj0']),
  )

  // Case 4: the source body is edited by a feature AFTER the projection sketch
  // (a fillet on the adjacent front-left edge shortens the projected
  // bottom-front edge). Re-solving the full doc must keep the projection
  // resolvable and reproduce the frozen output: the wire contract for
  // parametric associativity.
  await addProjectionCase(
    'project_downstream_edit',
    boxBase,
    (body) => [{ id: 'proj0', kind: 'line', source: pickEdgeQuery(body, ['@sk1/bottom', 'cls_yn', 'cls_zn']) }],
    (body) => [{
      id: 'fillet1', kind: 'fillet',
      edges: [pickEdgeQuery(body, ['@sk1/left', 'cls_xn', 'cls_zn'])],
      radius: 1.5,
    }],
    '@builtin_plane_front',
    (sk2) => assertGeometry(sk2, ['proj0']),
  )

  // Case 5: a circular edge whose plane is NOT parallel to the sketch plane
  // (top plane) -> the lowerer must promote it to an ellipse, not a
  // wrong-radius circle.
  await addProjectionCase(
    'project_tilted_circle_ellipse',
    cylBase,
    (body) => [{ id: 'proj0', kind: 'circle', source: pickCircleEdgeQuery(body) }],
    undefined, '@builtin_plane_top',
    (sk2) => {
      assertGeometry(sk2, ['proj0'])
      const resolved = (sk2.resolved_kinds as Record<string, string>) ?? {}
      if (resolved.proj0 !== 'ellipse') {
        throw new Error(`expected tilted circle to lower to an ellipse, got resolved_kinds=${JSON.stringify(resolved)}`)
      }
    },
  )
}

// ─── Array spec regen (the Python-era format drifted) ───

async function buildArrayCases(): Promise<ProjectionCase[]> {
  const out: ProjectionCase[] = []

  // Rectangular 3x2 of a 5x5x5 box; directions come from sketch lines so the
  // spec is self-contained and stable (the current array leaf requires them).
  const rect = partSpec([
    rectSketch('sk1', 5, 5),
    extrude('ex1', 'sk1', 5),
    lineDirectionSketch(),
    {
      id: 'arr1', kind: 'array',
      array: {
        source_body: '@ex1', mode: 'rectangular', count_x: 3, count_y: 2,
        pitch_x: 5, pitch_y: 5, include_source: true, operation: 'add',
        direction_x_query: '@sk_dir/lx', direction_y_query: '@sk_dir/ly',
      },
    },
  ])
  const rectSolved = await solveWithTimeout(rect, { prevState: null })
  if (!rectSolved) throw new Error('array_rectangular_3x2: solve returned null')
  const arr1 = (rectSolved.result as Record<string, Dict>).arr1
  if (arr1.status !== 'ok') throw new Error(`array_rectangular_3x2: arr1 ${arr1.status} ${JSON.stringify(arr1)}`)
  out.push({ label: 'array_rectangular_3x2', feature_kind: 'array', query_tier: 'anchor', spec: rect })

  // Circular array of a 2x2x2 box: 3 copies around Z, axis via a sketch circle.
  const circ = partSpec([
    rectSketch('sk1', 2, 2),
    extrude('ex1', 'sk1', 2),
    circleSketch('sk_axis', 5),
    {
      id: 'arr1', kind: 'circular_array',
      circular_array: {
        source_body: '@ex1', count: 3, include_source: true, operation: 'add',
        axis: '@sk_axis/c1', invert_axis: false,
      },
    },
  ])
  const circSolved = await solveWithTimeout(circ, { prevState: null })
  if (!circSolved) throw new Error('circular_array_3copies: solve returned null')
  const circArr1 = (circSolved.result as Record<string, Dict>).arr1
  if (circArr1.status !== 'ok') throw new Error(`circular_array_3copies: arr1 ${circArr1.status} ${JSON.stringify(circArr1)}`)
  out.push({ label: 'circular_array_3copies', feature_kind: 'circular_array', query_tier: 'ancestral', spec: circ })

  return out
}

// ─── Payload write ───

interface BaselineEntry {
  label: string
  ok: boolean
  error: string | null
  input_sketches: unknown[]
  spec: Record<string, unknown>
  result: Record<string, unknown>
  bodies: Record<string, unknown>
}

function entryFrom(c: { label: string; spec: Dict }, solved: { result: Dict; bodies: Record<string, unknown> }): BaselineEntry {
  const bodies: Record<string, unknown> = {}
  for (const [bid, rawBody] of Object.entries(solved.bodies)) {
    bodies[bid] = buildBaselineBody(bid, rawBody as Record<string, unknown>)
  }
  return { label: c.label, ok: true, error: null, input_sketches: [], spec: c.spec, result: solved.result, bodies }
}

async function main(): Promise<void> {
  console.log('regen: building projection cases...')
  await buildProjectionCases()
  console.log('regen: projection cases built:', projectionCases.map((c) => c.label).join(', '))
  console.log('regen: building array cases...')
  const arrayCases = await buildArrayCases()
  console.log('regen: array cases built')

  const entries: BaselineEntry[] = []
  for (const c of [...projectionCases, ...arrayCases]) {
    console.log(`regen: solve ${c.label}...`)
    const solved = await solveWithTimeout(c.spec, { prevState: null })
    if (!solved) throw new Error(`${c.label}: final solve returned null`)
    entries.push(entryFrom(c, solved))
  }

  const cases = [...projectionCases, ...arrayCases].map((c) => ({
    label: c.label,
    feature_kind: c.feature_kind,
    query_tier: c.query_tier,
    ok: true,
  }))
  writeFileSync(PAYLOAD_PATH, JSON.stringify({ entries, cases }, null, 1) + '\n')

  console.log(`payload written: ${PAYLOAD_PATH} (${entries.length} entries)`)
  console.log(`added: ${projectionCases.map((c) => c.label).join(', ')}`)
  console.log(`regenerated: ${arrayCases.map((c) => c.label).join(', ')}`)
  console.log('then run: python3 scripts/mergeCorpus.py')
  if (warn.length) console.warn('warnings:', warn.join('; '))

  // The solve child stays alive waiting for messages; kill it so this script
  // process can exit (otherwise the fork keeps the parent event loop open).
  disposeWorker()
}

main().catch((e) => {
  console.error('regen failed:', e)
  disposeWorker()
  process.exit(1)
})
