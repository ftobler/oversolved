// @vitest-environment node
//
// The pick table an instance pattern's targets form reads: a sketch entity takes
// its point from its kind and the sketch plane normal, a body face its centroid
// and outward normal (a bore its free-end axis), a circular edge its centre and
// its planar neighbour's normal, a straight edge and a vertex a point with no
// normal, and a datum plane its origin and normal. A whole sketch is refused.
//
// The body faces are resolved against a repository assembled from the solved
// render payload, the same shape the builder registers.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { initGlobalRepo, parseAncestry, parseConstructionUuidId, type Repository } from '../../query'
import type { OccModule } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { PartSolid } from '../../types3d'
import { resolvePickTarget, type PickTargetContext } from '../shared/pickTarget'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

const FRONT = '@builtin_plane_front'
const S30 = Math.sin(Math.PI / 6)
const C30 = Math.cos(Math.PI / 6)

function rectSketch(id: string, w: number, h: number): Dict {
  const points: [number, number][] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
  const entities = points.map((_, i) => ({ id: `l${i}`, kind: 'line' }))
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`, kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % points.length}`, point: 'start' },
    })
  })
  return { id, kind: 'sketch', plane: FRONT, entities, initial, constraints }
}

const topPlane = (z: number): Dict => ({
  id: 'plTop', kind: 'plane', definition: { mode: 'offset', plane: FRONT, offset: z },
})

function pointSketch(id: string, x: number, y: number): Dict {
  return { id, kind: 'sketch', plane: '@plTop', entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [x, y] }, constraints: [] }
}

/** The sketch-entity table's fixture: one row per entity kind on a plane tilted
 *  30 degrees about X, so a row that used the world plane would be caught. */
const SKETCH_ENTITIES: Dict[] = [
  { id: 'pt', kind: 'point' },
  { id: 'ln', kind: 'line' },
  { id: 'ci', kind: 'circle' },
  { id: 'ar', kind: 'arc' },
  { id: 'el', kind: 'ellipse' },
  { id: 'sp', kind: 'spline' },
  { id: 'fs', kind: 'fit_spline', handles: 'both' },
]

const SKETCH_INITIAL: Record<string, number[]> = {
  pt: [2, 3],
  ln: [0, 0, 4, 0],
  ci: [1, 1, 5],
  ar: [2, 1, 3, 0, 90],
  el: [3, 2, 4, 2, 0],
  sp: [0, 0, 1, 2, 3, 2, 4, 0],
  // Four fit points, then the start and end handles.
  fs: [0, 0, 2, 2, 4, 2, 6, 0, 1, 1, 5, 1],
}

const TILTED = {
  origin: [0, 0, 0],
  x_axis: [1, 0, 0],
  y_axis: [0, C30, S30],
  normal: [0, -S30, C30],
}

function lift(x: number, y: number): [number, number, number] {
  return [x, y * C30, y * S30]
}

describe.skipIf(!oc || !solveBytes)('the instance pattern pick table', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  // The one body a plate with a blind hole leaves, plain or countersunk.
  function buildPlate(style: 'simple' | 'countersink' = 'simple'): { r: BuildResponse; body: PartSolid; repo: Repository } {
    const hole: Dict = {
      sketch: '@skHole', diameter: 6, depth_mode: 'blind', depth: 5, direction: 'reverse',
      target: '@body_exPlate',
      ...(style === 'countersink' ? { style: 'countersink', cb_diameter: 10, cs_angle: 90 } : {}),
    }
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        rectSketch('skPlate', 40, 40),
        { id: 'exPlate', kind: 'extrude', extrude: { sketch: '@skPlate', distance: 10, operation: 'new' } },
        topPlane(10),
        pointSketch('skHole', 0, 0),
        { id: 'h1', kind: 'hole', hole },
      ],
    })
    expect(h.res(r, 'h1').status).toBe('ok')
    const part = (r._build_state!.checkpoints.h1.body_store_snapshot as Record<string, PartSolid>).body_exPlate
    const repo = initGlobalRepo()
    const payload = h.part(r, 'body_exPlate') as {
      mesh?: { face_data?: Dict[]; face_queries?: string[] }
      edges?: Dict[]
      edge_queries?: string[]
      vertices?: number[][]
      vertex_queries?: string[]
    }
    // Register each element under its own construction uuid, the tier a real
    // pick query resolves through; the ancestry tokens alone would let every
    // face of the body match every other face's query.
    const uuidOf = (query: string): string | null => {
      const [ids] = parseAncestry(query)
      for (const id of ids) {
        const uuid = parseConstructionUuidId(id)
        if (uuid !== null) return uuid
      }
      return null
    }
    payload.mesh?.face_data?.forEach((data, i) => {
      const query = payload.mesh?.face_queries?.[i]
      if (!query) return
      const [ids] = parseAncestry(query)
      repo.registerAncestor(ids, {
        type: data.surface_type,
        body_id: 'body_exPlate',
        face_index: i,
        centroid: data.centroid,
        normal: data.normal,
      }, uuidOf(query))
    })
    payload.edges?.forEach((edge, i) => {
      const query = payload.edge_queries?.[i]
      if (!query) return
      const [ids] = parseAncestry(query)
      repo.registerAncestor(ids, {
        type: edge.kind === 'line' ? 'straightedge' : 'edge',
        body_id: 'body_exPlate',
        edge_index: i,
        ...edge,
      }, uuidOf(query))
    })
    payload.vertices?.forEach((origin, i) => {
      const query = payload.vertex_queries?.[i]
      if (!query) return
      const [ids] = parseAncestry(query)
      repo.registerAncestor(ids, { type: 'vertex', body_id: 'body_exPlate', vertex_index: i, origin }, uuidOf(query))
    })
    repo.register('_pt_skT', TILTED)
    return { r, body: part, repo }
  }

  function context(repo: Repository, part: PartSolid): PickTargetContext {
    return {
      oc: occ,
      scope: new DisposeScope(),
      table: h.table,
      globalRepo: repo,
      partStore: { body_exPlate: part },
      featuresById: {
        skT: { id: 'skT', kind: 'sketch', plane: FRONT, entities: SKETCH_ENTITIES, initial: SKETCH_INITIAL, constraints: [] },
      },
    }
  }

  function targets(r: BuildResponse): {
    faces: (Dict & { query: string })[]
    edges: (Dict & { query: string })[]
    vertices: { origin: number[]; query: string }[]
  } {
    const payload = h.part(r, 'body_exPlate') as {
      mesh?: { face_data?: Dict[]; face_queries?: string[] }
      edges?: Dict[]
      edge_queries?: string[]
      vertices?: number[][]
      vertex_queries?: string[]
    }
    return {
      faces: (payload.mesh?.face_data ?? []).map((data, i) => ({ ...data, query: payload.mesh?.face_queries?.[i] ?? '' })),
      edges: (payload.edges ?? []).map((edge, i) => ({ ...edge, query: payload.edge_queries?.[i] ?? '' })),
      vertices: (payload.vertices ?? []).map((origin, i) => ({ origin, query: payload.vertex_queries?.[i] ?? '' })),
    }
  }

  it('resolves a planar face to its centroid and outward normal', () => {
    const { r, body, repo } = buildPlate()
    const top = targets(r).faces.find((face) =>
      face.surface_type === 'flatface' && (face.normal as number[])[2] > 0.99 && (face.centroid as number[])[2] > 9)!
    const ctx = context(repo, body)
    try {
      const target = resolvePickTarget(ctx, top.query)!
      expect(target.point[2]).toBeCloseTo(10, 6)
      expect(target.normal![2]).toBeCloseTo(1, 6)
    } finally {
      ctx.scope.dispose()
    }
  })

  it('resolves a bore face to the axis point at its mouth', () => {
    const { r, body, repo } = buildPlate()
    const bore = targets(r).faces.find((face) => face.surface_type === 'cylinderface')!
    const ctx = context(repo, body)
    try {
      const target = resolvePickTarget(ctx, bore.query)!
      expect(target.normal![2]).toBeCloseTo(1, 6)
      expect(target.point[2]).toBeCloseTo(10, 6)
    } finally {
      ctx.scope.dispose()
    }
  })

  it('resolves the countersink cone to its wide end', () => {
    const { r, body, repo } = buildPlate('countersink')
    const cone = targets(r).faces.find((face) => face.surface_type === 'coneface')!
    const ctx = context(repo, body)
    try {
      const target = resolvePickTarget(ctx, cone.query)!
      expect(target.normal![2]).toBeCloseTo(1, 6)
      expect(target.point[2]).toBeCloseTo(10, 6)
    } finally {
      ctx.scope.dispose()
    }
  })

  it('resolves the mouth circle edge to the face normal of the plate top', () => {
    const { r, body, repo } = buildPlate()
    const mouth = targets(r).edges.find((edge) =>
      edge.kind === 'circle' && Math.abs((edge.center as number[])[2] - 10) < 1e-6 && Math.abs((edge.radius as number) - 3) < 1e-6)!
    const ctx = context(repo, body)
    try {
      const target = resolvePickTarget(ctx, mouth.query)!
      expect(target.point[2]).toBeCloseTo(10, 6)
      expect(target.normal![2]).toBeCloseTo(1, 6)
    } finally {
      ctx.scope.dispose()
    }
  })

  it('resolves a straight edge and a vertex with no normal', () => {
    const { r, body, repo } = buildPlate()
    const straight = targets(r).edges.find((edge) =>
      edge.kind === 'line' && (edge.start as number[])[2] === (edge.end as number[])[2])!
    const vertex = targets(r).vertices[0]
    const ctx = context(repo, body)
    try {
      const edgeTarget = resolvePickTarget(ctx, straight.query)!
      expect(edgeTarget.normal).toBeNull()
      expect(edgeTarget.point[2]).toBeCloseTo((straight.start as number[])[2], 6)
      const vertexTarget = resolvePickTarget(ctx, vertex.query)!
      expect(vertexTarget.normal).toBeNull()
      expect(vertexTarget.point).toEqual(vertex.origin)
    } finally {
      ctx.scope.dispose()
    }
  })

  it('resolves a datum plane to its origin and normal', () => {
    const { body, repo } = buildPlate()
    const ctx = context(repo, body)
    try {
      const target = resolvePickTarget(ctx, '@builtin_plane_front')!
      expect(target.point).toEqual([0, 0, 0])
      expect(target.normal).toEqual([0, 0, 1])
    } finally {
      ctx.scope.dispose()
    }
  })

  it('takes every sketch entity point from its kind on the tilted sketch plane', () => {
    const { body, repo } = buildPlate()
    const ctx = context(repo, body)
    try {
      const expected: [string, [number, number, number]][] = [
        ['pt', lift(2, 3)],
        ['ln', lift(2, 0)],
        ['ci', lift(1, 1)],
        ['ar', lift(2, 1)],
        ['el', lift(3, 2)],
        // Cubic Bezier middle station: (P1 + 3 P2 + 3 P3 + P4) / 8.
        ['sp', lift(2, 1.5)],
        ['fs', lift(2, 2)],
      ]
      for (const [entity, point] of expected) {
        const target = resolvePickTarget(ctx, `entity:skT:${entity}`)!
        expect(target.key).toBe(entity)
        expect(target.point[0]).toBeCloseTo(point[0], 6)
        expect(target.point[1]).toBeCloseTo(point[1], 6)
        expect(target.point[2]).toBeCloseTo(point[2], 6)
        expect(target.normal![0]).toBeCloseTo(TILTED.normal[0], 6)
        expect(target.normal![1]).toBeCloseTo(TILTED.normal[1], 6)
        expect(target.normal![2]).toBeCloseTo(TILTED.normal[2], 6)
      }
    } finally {
      ctx.scope.dispose()
    }
  })

  it('refuses a whole sketch as one point pick, naming the sketch', () => {
    // The pattern's target list expands a sketch row before the table sees it;
    // the reference pick has no such expansion, so the table still says a whole
    // sketch names no single point.
    const { body, repo } = buildPlate()
    const ctx = context(repo, body)
    try {
      expect(() => resolvePickTarget(ctx, '@skT')).toThrow(/is a whole sketch.*pick one of its points/)
    } finally {
      ctx.scope.dispose()
    }
  })
})
