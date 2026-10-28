// @vitest-environment node
//
// Real-OCC multisection sweep: the build123d handle example rebuilt through
// solveSweep with the station planes of the plan's section 7 table, plus the
// closed-form frustum cases and the named refusals.
//
// Seeded repositories (not a full document) because the assertions need the
// built solid: volume, face count and the construction names. The document
// route (planes, sketches, the drive script) is covered by
// drive/__tests__/sweepMultisectionReal.test.ts.
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { volumeOf } from '../../occ/volume'
import { readSolidVertices } from '../../occ/primitives'
import { Repository } from '../../query'
import { solveSweep } from '../sweep'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

type Dict = Record<string, unknown>
type Vec2 = [number, number]

const FRONT = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
// The builtin top plane: sketch (u, v) -> world (u, 0, -v).
const TOP = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0] }

// Station P and in-plane normal N from the plan's section 7 table (the path is
// on the Front plane, so N is the section plane's local x axis).
const STATIONS: { p: Vec2; n: Vec2 }[] = [
  { p: [-10, 0], n: [1, 0] },
  { p: [-8.428892, 3.8503], n: [0.600653, -0.79951] },
  { p: [-4.320748, 4.978977], n: [0.053869, -0.998548] },
  { p: [0, 5], n: [0, 1] },
  { p: [4.320748, 4.978977], n: [-0.053869, -0.998548] },
  { p: [8.428892, 3.8503], n: [-0.600653, -0.79951] },
  { p: [10, 0], n: [-1, 0] },
]

/** The frame `line_angle` gives for a line from P along N on the Front plane. */
function stationPlane(i: number): { origin: number[]; x_axis: number[]; y_axis: number[]; normal: number[] } {
  const { p, n } = STATIONS[i]
  const x = [n[0], n[1], 0]
  const y = [0, 0, 1]
  return {
    origin: [p[0], p[1], 0],
    x_axis: x,
    y_axis: y,
    normal: [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]],
  }
}

function arcEdge(id: string, cx: number, cy: number, r: number, a0: number, a1: number): Dict {
  const rad = (d: number): number => (d * Math.PI) / 180
  return {
    id,
    kind: 'arc',
    center: [cx, cy],
    radius: r,
    angle_start_deg: a0,
    angle_end_deg: a1,
    ccw: true,
    start: [cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0))],
    end: [cx + r * Math.cos(rad(a1)), cy + r * Math.sin(rad(a1))],
  }
}

/** A circle as the two half arcs the sketch topology emits, both carrying the
 *  entity's own id (trace.rs circle_arcs). */
function circleBoundary(id: string, r: number, cx = 0, cy = 0): Dict[] {
  return [arcEdge(id, cx, cy, r, 0, 180), arcEdge(id, cx, cy, r, 180, 360)]
}

/** A rounded rectangle boundary: four lines and four corner arcs, ids prefixed
 *  so the naming test can tell the entities apart. */
function roundedRectBoundary(w: number, h: number, r: number, prefix: string): Dict[] {
  const hx = w / 2
  const hy = h / 2
  const line = (id: string, a: Vec2, b: Vec2): Dict => ({ id, kind: 'line', start: a, end: b })
  const arc = (id: string, c: Vec2, a0: number, a1: number): Dict => arcEdge(id, c[0], c[1], r, a0, a1)
  return [
    line(prefix + '1', [-hx + r, -hy], [hx - r, -hy]),
    arc(prefix + '2', [hx - r, -hy + r], -90, 0),
    line(prefix + '3', [hx, -hy + r], [hx, hy - r]),
    arc(prefix + '4', [hx - r, hy - r], 0, 90),
    line(prefix + '5', [hx - r, hy], [-hx + r, hy]),
    arc(prefix + '6', [-hx + r, hy - r], 90, 180),
    line(prefix + '7', [-hx, hy - r], [-hx, -hy + r]),
    arc(prefix + '8', [-hx + r, -hy + r], 180, 270),
  ]
}

function squareBoundary(side: number, prefix: string): Dict[] {
  const h = side / 2
  const c: Vec2[] = [[-h, -h], [h, -h], [h, h], [-h, h]]
  return c.map((p, i) => ({
    id: prefix + (i + 1), kind: 'line', start: p, end: c[(i + 1) % 4],
  }))
}

function registerSection(repo: Repository, sketchId: string, plane: Dict, boundary: Dict[]): void {
  repo.register('_pt_' + sketchId, plane)
  repo.register('_topo_' + sketchId, { surfaces: [{ boundary }] })
}

/** The handle's sections: circles at both ends, five rounded rectangles between
 *  them, each on its own station plane. */
function seedHandleRepo(): Repository {
  const repo = new Repository()
  repo.register('_pt_path', FRONT)
  repo.register('_topo_path', {
    edges: [
      {
        entity_id: 'p0', edge_index: 0, kind: 'spline',
        start: [-10, 0], c1: [-10, 5.590169943749474], c2: [-5, 5], end: [0, 5],
      },
      {
        entity_id: 'p1', edge_index: 1, kind: 'spline',
        start: [0, 5], c1: [5, 5], c2: [10, 5.590169943749474], end: [10, 0],
      },
    ],
  })
  registerSection(repo, 'c0', TOP, circleBoundary('c0', 1, -10, 0))
  for (let i = 1; i <= 5; i++) {
    registerSection(repo, 's' + i, stationPlane(i), roundedRectBoundary(1.25, 3, 0.2, 's' + i))
  }
  registerSection(repo, 'c6', TOP, circleBoundary('c6', 1, 10, 0))
  return repo
}

const HANDLE_SECTIONS = ['@c0', '@s1', '@s2', '@s3', '@s4', '@s5', '@c6']

type Solved = {
  volume: number
  body: Body
  bbox: { min: number[]; max: number[] }
  status: string
  exception?: string
}

function bboxOf(occ: OccModule, scope: DisposeScope, solid: OccShape): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const v of readSolidVertices(occ, scope, solid)) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i]
      if (v[i] > max[i]) max[i] = v[i]
    }
  }
  return { min, max }
}

function solve(
  occ: OccModule,
  repo: Repository,
  sweep: Dict,
): { solved: Solved | null; error: string | null } {
  const scope = new DisposeScope()
  const table = new HandleTable()
  const bodyStore: Record<string, Body> = {}
  try {
    try {
      const result = solveSweep(
        occ, scope, table, { id: 'sw1', kind: 'sweep', sweep }, repo, bodyStore,
      )
      const body = bodyStore['body_sw1']
      if (body === undefined || body.shape === null) throw new Error('no body')
      const solid = table.get<OccShape>(body.shape)
      return {
        solved: {
          volume: volumeOf(occ, scope, solid),
          body,
          bbox: bboxOf(occ, scope, solid),
          status: String(result.status),
          exception: typeof result.exception === 'string' ? result.exception : undefined,
        },
        error: null,
      }
    } catch (e) {
      return { solved: null, error: (e as Error).message }
    }
  } finally {
    table.disposeAll()
    scope.dispose()
  }
}

function tokenMultiset(d: Record<string, string[]> | undefined): string[] {
  return Object.values(d ?? {})
    .filter((v) => v.length > 0)
    .map((v) => JSON.stringify([...v].sort()))
    .sort()
}

describe.skipIf(!oc)('sweep multisection (real OCC)', () => {
  it('builds the handle at the build123d volume with every face named', () => {
    const { solved, error } = solve(oc!, seedHandleRepo(), {
      sketch: HANDLE_SECTIONS, path: '@path', multisection: true, operation: 'new',
    })
    expect(error).toBeNull()
    if (!solved) throw new Error('no solid')
    // build123d asserts 94.7736; the two-Bezier spine measured 94.7809299 in
    // the shipped 7.4, the same value the step-0 probe pinned.
    expect(Math.abs(solved.volume - 94.7736)).toBeLessThan(0.05)
    expect(solved.volume).toBeCloseTo(94.7809299, 3)
    expect(solved.body.face_uuids).toHaveLength(22)
    expect(solved.body.face_uuids?.every((u) => u !== null)).toBe(true)
    expect(solved.bbox.min[0]).toBeCloseTo(-11, 1)
    expect(solved.bbox.max[0]).toBeCloseTo(11, 1)
    expect(solved.bbox.min[2]).toBeCloseTo(-1.5, 1)
    expect(solved.bbox.max[2]).toBeCloseTo(1.5, 1)
  }, 60_000)

  it('names every wall of the richest section and each cap from its own end', () => {
    const { solved } = solve(oc!, seedHandleRepo(), {
      sketch: HANDLE_SECTIONS, path: '@path', multisection: true, operation: 'new',
    })
    if (!solved) throw new Error('no solid')
    const ancestry = solved.body.face_ancestry ?? {}
    const tokens = Object.values(ancestry).flat()
    // The naming section is the first rounded rectangle (8 edges, earliest
    // station), so each of its eight entities owns a wall.
    for (let i = 1; i <= 8; i++) expect(tokens).toContain(`@s1/s1${i}`)
    // Caps carry their OWN end section's tokens, not the naming section's.
    const caps = tokenMultiset(solved.body.face_cap_ancestry)
    expect(caps).toEqual([JSON.stringify(['@c0/c0']), JSON.stringify(['@c6/c6'])].sort())
    // A circle never names the eighteen faces its seam splits into.
    expect(tokens.some((t) => t.startsWith('@c0/') || t.startsWith('@c6/'))).toBe(false)
  }, 60_000)

  it('gives the same volume and names for a reversed profile list', () => {
    const forward = solve(oc!, seedHandleRepo(), {
      sketch: HANDLE_SECTIONS, path: '@path', multisection: true, operation: 'new',
    })
    const reversed = solve(oc!, seedHandleRepo(), {
      sketch: [...HANDLE_SECTIONS].reverse(), path: '@path', multisection: true, operation: 'new',
    })
    if (!forward.solved || !reversed.solved) throw new Error('no solid')
    expect(reversed.solved.volume).toBeCloseTo(forward.solved.volume, 6)
    expect(tokenMultiset(reversed.solved.body.face_ancestry))
      .toEqual(tokenMultiset(forward.solved.body.face_ancestry))
    expect(tokenMultiset(reversed.solved.body.face_cap_ancestry))
      .toEqual(tokenMultiset(forward.solved.body.face_cap_ancestry))
  }, 120_000)

  it('refuses the same document without the opt-in, naming the way out', () => {
    const { error } = solve(oc!, seedHandleRepo(), {
      sketch: HANDLE_SECTIONS, path: '@path', operation: 'new',
    })
    expect(error).toMatch(/spans two different sketch planes/)
    expect(error).toMatch(/set multisection to sweep through them as sections/)
  })

  it('interpolates two circles linearly into the cone frustum', () => {
    const repo = new Repository()
    repo.register('_pt_path', FRONT)
    repo.register('_topo_path', {
      edges: [{ entity_id: 'p0', edge_index: 0, kind: 'line', start: [0, 0], end: [0, 10] }],
    })
    const planeAt = (y: number): Dict => ({
      origin: [0, y, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, -1, 0],
    })
    registerSection(repo, 'a', planeAt(0), circleBoundary('a', 1))
    registerSection(repo, 'b', planeAt(10), circleBoundary('b', 2))
    const { solved, error } = solve(oc!, repo, {
      sketch: ['@a', '@b'], path: '@path', multisection: true, operation: 'new',
    })
    expect(error).toBeNull()
    // pi*h/3*(r1^2 + r1*r2 + r2^2), h = 10, r1 = 1, r2 = 2.
    expect(solved?.volume).toBeCloseTo(73.303829, 3)
  })

  it('interpolates two squares into the pyramid frustum', () => {
    const repo = new Repository()
    repo.register('_pt_path', FRONT)
    repo.register('_topo_path', {
      edges: [{ entity_id: 'p0', edge_index: 0, kind: 'line', start: [0, 0], end: [0, 10] }],
    })
    const planeAt = (y: number): Dict => ({
      origin: [0, y, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, -1, 0],
    })
    registerSection(repo, 'a', planeAt(0), squareBoundary(2, 'a'))
    registerSection(repo, 'b', planeAt(10), squareBoundary(4, 'b'))
    const { solved, error } = solve(oc!, repo, {
      sketch: ['@a', '@b'], path: '@path', multisection: true, operation: 'new',
    })
    expect(error).toBeNull()
    // h/3*(A1 + A2 + sqrt(A1*A2)), h = 10, A1 = 4, A2 = 16.
    expect(solved?.volume).toBeCloseTo(93.333333, 3)
  })

  it('refuses an 8/4 edge-count mismatch by name instead of building it', () => {
    // The shipped 7.4 does not throw here (the probe measured a valid but wrong
    // 28-face solid), so the refusal has to come from the edge-count check.
    const repo = new Repository()
    repo.register('_pt_path', FRONT)
    repo.register('_topo_path', {
      edges: [{ entity_id: 'p0', edge_index: 0, kind: 'line', start: [0, 0], end: [0, 10] }],
    })
    const planeAt = (y: number): Dict => ({
      origin: [0, y, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, -1, 0],
    })
    registerSection(repo, 'a', planeAt(0), roundedRectBoundary(2, 2, 0.2, 'a'))
    registerSection(repo, 'b', planeAt(10), squareBoundary(2, 'b'))
    const { error } = solve(oc!, repo, {
      sketch: ['@a', '@b'], path: '@path', multisection: true, operation: 'new',
    })
    expect(error).toMatch(/the sections could not be matched \(edge counts 8 at station 1, 4 at station 2\)/)
    expect(error).toMatch(/give neighbouring sections the same number of edges/)
  })

  it('refuses a section the path does not pass through', () => {
    const repo = new Repository()
    repo.register('_pt_path', FRONT)
    repo.register('_topo_path', {
      edges: [{ entity_id: 'p0', edge_index: 0, kind: 'line', start: [0, 0], end: [0, 10] }],
    })
    const planeAt = (y: number): Dict => ({
      origin: [0, y, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, -1, 0],
    })
    registerSection(repo, 'a', planeAt(0), squareBoundary(2, 'a'))
    registerSection(repo, 'b', planeAt(10), squareBoundary(2, 'b'))
    // A third section on a plane the spine crosses far from its loop.
    const far: Dict = {
      origin: [100, 5, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, -1, 0],
    }
    registerSection(repo, 'c', far, squareBoundary(2, 'c'))
    const { error } = solve(oc!, repo, {
      sketch: ['@a', '@b', '@c'], path: '@path', multisection: true, operation: 'new',
    })
    expect(error).toMatch(/sweep: section 3 is not on the path: the path does not pass through it/)
  })

  it('builds the remaining sections and reports the failed ref as partial', () => {
    const repo = new Repository()
    repo.register('_pt_path', FRONT)
    repo.register('_topo_path', {
      edges: [{ entity_id: 'p0', edge_index: 0, kind: 'line', start: [0, 0], end: [0, 10] }],
    })
    const planeAt = (y: number): Dict => ({
      origin: [0, y, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, -1, 0],
    })
    registerSection(repo, 'a', planeAt(0), circleBoundary('a', 1))
    registerSection(repo, 'b', planeAt(10), circleBoundary('b', 2))
    const { solved, error } = solve(oc!, repo, {
      sketch: ['@a', '@missing', '@b'], path: '@path', multisection: true, operation: 'new',
    })
    expect(error).toBeNull()
    expect(solved?.status).toBe('partial')
    expect(solved?.exception).toMatch(/@missing/)
    // The two surviving sections still build the frustum.
    expect(solved?.volume).toBeCloseTo(73.303829, 3)
  })

  it('reports the failed ref itself when too few sections remain', () => {
    const repo = new Repository()
    repo.register('_pt_path', FRONT)
    repo.register('_topo_path', {
      edges: [{ entity_id: 'p0', edge_index: 0, kind: 'line', start: [0, 0], end: [0, 10] }],
    })
    const planeAt = (y: number): Dict => ({
      origin: [0, y, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, -1, 0],
    })
    registerSection(repo, 'a', planeAt(0), circleBoundary('a', 1))
    const { error } = solve(oc!, repo, {
      sketch: ['@a', '@missing'], path: '@path', multisection: true, operation: 'new',
    })
    expect(error ?? '').toMatch(/@missing/)
    expect(error ?? '').not.toMatch(/needs at least two sections/)
  })

  it('keeps one body for the handle', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const bodyStore: Record<string, Body> = {}
    try {
      const result = solveSweep(oc!, scope, table, {
        id: 'sw1', kind: 'sweep',
        sweep: { sketch: HANDLE_SECTIONS, path: '@path', multisection: true, operation: 'new' },
      }, seedHandleRepo(), bodyStore)
      expect(result.status).toBe('ok')
      expect(Object.keys(bodyStore)).toEqual(['body_sw1'])
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  }, 60_000)
})
