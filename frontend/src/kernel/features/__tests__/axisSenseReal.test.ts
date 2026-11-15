// @vitest-environment node
//
// The free-end rule through the real kernel: a blind hole's bore points out of
// its mouth, a boss cylinder out of its top, a countersink cone out of its wide
// end, and a through hole falls back to the surface's own axis sense, stable
// over a re-solve and after an upstream edit. The mouth circle agrees with its
// bore face, which is the rule the circular-edge target uses.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { canonicalEdges, canonicalFaces } from '../../occ/bodyNames'
import { edgeToGeom, faceSurfaceType } from '../../occ/primitives'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'
import { circularEdgeSense, faceFreeEnd, type AxisSenseContext } from '../shared/axisSense'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

function pointSketch(id: string, x: number, y: number): Dict {
  return {
    id, kind: 'sketch', plane: '@plTop',
    entities: [{ id: 'p1', kind: 'point' }],
    initial: { p1: [x, y] },
    constraints: [],
  }
}

function circleSketch(id: string, x: number, y: number, r: number): Dict {
  return {
    id, kind: 'sketch', plane: '@plTop',
    entities: [{ id: 'c1', kind: 'circle' }],
    initial: { c1: [x, y, r] },
    constraints: [],
  }
}

const topPlane = (z: number): Dict => ({
  id: 'plTop', kind: 'plane',
  definition: { mode: 'offset', plane: '@builtin_plane_front', offset: z },
})

function plate(z: number): Dict[] {
  return [
    topPlane(z),
    { id: 'skPlate', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'l0', kind: 'line' }, { id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }, { id: 'l3', kind: 'line' }],
      initial: { l0: [-40, -40, 40, -40], l1: [40, -40, 40, 40], l2: [40, 40, -40, 40], l3: [-40, 40, -40, -40] },
      constraints: [] },
    { id: 'exPlate', kind: 'extrude', extrude: { sketch: '@skPlate', distance: z, operation: 'new' } },
  ]
}

describe.skipIf(!oc || !solveBytes)('the free-end rule through the real kernel', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function bodyAt(r: BuildResponse, featureId: string, bodyId: string): Body {
    return (r._build_state!.checkpoints[featureId].body_store_snapshot as Record<string, Body>)[bodyId]
  }

  function senseContext(): AxisSenseContext {
    const scope = new DisposeScope()
    return {
      oc: occ,
      scope,
      table: h.table,
      facesOf: (body: Body) => body.shape === null
        ? []
        : canonicalFaces(occ, scope, h.table.get<OccShape>(body.shape)) as OccShape[],
    }
  }

  function cylinderFaces(ctx: AxisSenseContext, body: Body): OccShape[] {
    return ctx.facesOf(body).filter((face) => faceSurfaceType(occ, ctx.scope, face) === 'cylinderface')
  }

  function coneFaces(ctx: AxisSenseContext, body: Body): OccShape[] {
    return ctx.facesOf(body).filter((face) => faceSurfaceType(occ, ctx.scope, face) === 'coneface')
  }

  function circularEdges(ctx: AxisSenseContext, body: Body): { edge: OccShape; center: number[]; axis: number[] }[] {
    const shape = h.table.get<OccShape>(body.shape!)
    return canonicalEdges(occ, ctx.scope, shape).flatMap((edge) => {
      try {
        const ed = edgeToGeom(occ, ctx.scope, edge as OccShape).ed
        return ed.kind === 'circle' ? [{ edge: edge as OccShape, center: ed.center, axis: ed.axis }] : []
      } catch {
        return []
      }
    })
  }

  it('points a blind hole bore out of its mouth', () => {
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        ...plate(10),
        pointSketch('skHole', 0, 0),
        { id: 'h1', kind: 'hole', hole: {
          sketch: '@skHole', diameter: 6, depth_mode: 'blind', depth: 5, direction: 'reverse', target: '@body_exPlate',
        } },
      ],
    })
    expect(h.res(r, 'h1').status).toBe('ok')
    const body = bodyAt(r, 'h1', 'body_exPlate')
    const ctx = senseContext()
    try {
      const bores = cylinderFaces(ctx, body)
      expect(bores).toHaveLength(1)
      const end = faceFreeEnd(ctx, body, bores[0])!
      expect(end.normal[2]).toBeCloseTo(1, 6)
      // The mouth is the plate top at z = 10.
      expect(end.point[2]).toBeCloseTo(10, 6)
    } finally {
      ctx.scope.dispose()
    }
  })

  it('points a boss cylinder out of its top', () => {
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        ...plate(10),
        circleSketch('skBoss', 0, 0, 5),
        // Fused into the plate: the boss base's neighbour is the plate top, the
        // case the free-end rule is drawn from. A standalone body's own bottom
        // cap would face down and read as a second free end.
        { id: 'exBoss', kind: 'extrude', extrude: { sketch: '@skBoss', distance: 8, operation: 'add', merge_target: '@body_exPlate' } },
      ],
    })
    expect(h.res(r, 'exBoss').status).toBe('ok')
    const body = bodyAt(r, 'exBoss', 'body_exPlate')
    const ctx = senseContext()
    try {
      const sides = cylinderFaces(ctx, body)
      expect(sides).toHaveLength(1)
      const end = faceFreeEnd(ctx, body, sides[0])!
      expect(end.normal[2]).toBeCloseTo(1, 6)
      // The boss sits on the plate top (10) and rises 8 mm.
      expect(end.point[2]).toBeCloseTo(18, 6)
    } finally {
      ctx.scope.dispose()
    }
  })

  it('points a countersink cone out of its wide end', () => {
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        ...plate(10),
        pointSketch('skHole', 0, 0),
        { id: 'h1', kind: 'hole', hole: {
          sketch: '@skHole', diameter: 6, depth_mode: 'blind', depth: 5, direction: 'reverse', target: '@body_exPlate',
          style: 'countersink', cb_diameter: 10, cs_angle: 90,
        } },
      ],
    })
    expect(h.res(r, 'h1').status).toBe('ok')
    const body = bodyAt(r, 'h1', 'body_exPlate')
    const ctx = senseContext()
    try {
      const cones = coneFaces(ctx, body)
      expect(cones).toHaveLength(1)
      const end = faceFreeEnd(ctx, body, cones[0])!
      expect(end.normal[2]).toBeCloseTo(1, 6)
      expect(end.point[2]).toBeCloseTo(10, 6)
    } finally {
      ctx.scope.dispose()
    }
  })

  it('keeps a through hole on the OCC axis sense, stable across a rebuild', () => {
    const doc = (thickness: number): Record<string, unknown> => ({
      version: 9, kind: 'part',
      features: [
        ...plate(thickness),
        pointSketch('skHole', 0, 0),
        { id: 'h1', kind: 'hole', hole: {
          sketch: '@skHole', diameter: 6, depth_mode: 'through_all', direction: 'reverse', target: '@body_exPlate',
        } },
      ],
    })
    const first = h.run(doc(10))
    const second = h.run(doc(14))
    expect(h.res(first, 'h1').status).toBe('ok')
    expect(h.res(second, 'h1').status).toBe('ok')
    const ctx = senseContext()
    try {
      const a = faceFreeEnd(ctx, bodyAt(first, 'h1', 'body_exPlate'), cylinderFaces(ctx, bodyAt(first, 'h1', 'body_exPlate'))[0])!
      const b = faceFreeEnd(ctx, bodyAt(second, 'h1', 'body_exPlate'), cylinderFaces(ctx, bodyAt(second, 'h1', 'body_exPlate'))[0])!
      expect(a.normal.map((n) => Math.sign(n))).toEqual(b.normal.map((n) => Math.sign(n)))
      // Two free ends give the surface's own sense: an end, not the middle.
      expect(Math.min(Math.abs(a.point[2]), Math.abs(a.point[2] - 10))).toBeLessThan(1e-6)
    } finally {
      ctx.scope.dispose()
    }
  })

  it('makes the mouth circle agree with its bore face', () => {
    const r = h.run({
      version: 9, kind: 'part',
      features: [
        ...plate(10),
        pointSketch('skHole', 0, 0),
        { id: 'h1', kind: 'hole', hole: {
          sketch: '@skHole', diameter: 6, depth_mode: 'blind', depth: 5, direction: 'reverse', target: '@body_exPlate',
        } },
      ],
    })
    expect(h.res(r, 'h1').status).toBe('ok')
    const body = bodyAt(r, 'h1', 'body_exPlate')
    const ctx = senseContext()
    try {
      const bore = faceFreeEnd(ctx, body, cylinderFaces(ctx, body)[0])!
      const mouth = circularEdges(ctx, body).find((candidate) => Math.abs(candidate.center[2] - 10) < 1e-6)
      expect(mouth).toBeDefined()
      const edgeSense = circularEdgeSense(ctx, body, mouth!.edge, mouth!.center as [number, number, number], mouth!.axis as [number, number, number])
      expect(edgeSense.normal[2]).toBeCloseTo(bore.normal[2], 6)
    } finally {
      ctx.scope.dispose()
    }
  })
})
