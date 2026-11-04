// @vitest-environment node
//
// Pattern and array attribution through the production builder: a copy answers
// to the feature that minted it, the source instance keeps the source feature's
// creator, and a boolean tool body's faces keep their own creator rather than
// the target's base feature. These are the three report shapes from
// feature/pattern-instance-fuse.md (flange, focusrite, organiser collets) rebuilt
// as documents, plus a boolean with two array tools.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { parseAncestry } from '../../query'
import { selectByPredicate } from '../../select'
import { solidToEdges } from '../../occ/tessellation'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'
import type { BodyResult, EdgeData } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

interface FaceMesh {
  face_data?: { centroid: number[]; surface_type?: string }[]
  face_queries?: string[]
}

function polySketch(id: string, points: [number, number][], plane = '@builtin_plane_front'): Dict {
  const n = points.length
  const entities: Dict[] = []
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    entities.push({ id: `l${i}`, kind: 'line' })
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`, kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % n}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  }
  return { id, kind: 'sketch', plane, entities, initial, constraints }
}

function rectSketch(id: string, x0: number, y0: number, w: number, h: number, plane = '@builtin_plane_front'): Dict {
  return polySketch(id, [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], plane)
}

function circleSketch(id: string, cx: number, cy: number, r: number, plane = '@builtin_plane_front'): Dict {
  return {
    id, kind: 'sketch', plane,
    entities: [{ id: 'c1', kind: 'circle' }],
    initial: { c1: [cx, cy, r] },
    constraints: [{ id: 'r1', kind: 'radius', target: { entity: 'c1' } }],
  }
}

function extrude(id: string, sketch: string, distance: number, operation = 'new'): Dict {
  return { id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation } }
}

function pattern(id: string, fields: Dict): Dict {
  return { id, kind: 'pattern', pattern: fields }
}

function faceOwnerOf(query: string): string | null {
  const [ids] = parseAncestry(query)
  // buildFaceQuery emits uuid, then @creator, then @body, then ancestry.
  const at = ids.findIndex((token) => token.startsWith('@u|'))
  const creator = at >= 0 ? ids[at + 1] : ids[0]
  return creator?.slice(1) ?? null
}

function edgeIdsOf(query: string): string[] {
  return parseAncestry(query)[0]
}

describe.skipIf(!oc || !solveBytes)('pattern attribution (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  const facesOf = (r: BuildResponse, bodyId: string): FaceMesh => (h.body(r, bodyId).mesh ?? {}) as FaceMesh
  function bodyAt(r: BuildResponse, featureId: string, bodyId: string): Body {
    return r._build_state!.checkpoints[featureId].body_store_snapshot[bodyId] as Body
  }
  function edgesOf(r: BuildResponse, featureId: string, bodyId: string): { edges: EdgeData[]; queries: string[] } {
    const body = bodyAt(r, featureId, bodyId)
    const res = solidToEdges(oc!, h.table, body.shape!, {
      createdBy: body.created_by,
      bodyId: body.id,
      profileQueries: body.profile_queries,
      edgeAncestry: body.edge_ancestry ?? null,
      edgeUuids: body.edge_uuids ?? null,
      edgeOwner: body.edge_owner ?? null,
      modifiedBy: body.modified_by,
    })
    return { edges: res.edges, queries: res.edge_queries }
  }

  it('flange: the source hole is ex_mh, the three copies are pat_mh, none ex_base', () => {
    const r = h.run({
      features: [
        circleSketch('sk_base', 0, 0, 5),
        extrude('ex_base', '$sk_base', 2),
        circleSketch('sk_mh', 3, 0, 0.3125),
        extrude('ex_mh', '$sk_mh', 5, 'cut'),
        pattern('pat_mh', {
          subject: 'feature', source_feature: '@ex_mh',
          mode: 'circular', count: 4, step_angle: 90,
          axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
        }),
      ],
    })
    expect(h.res(r, 'pat_mh').status).toBe('ok')
    const mesh = facesOf(r, 'body_ex_base')
    const holeWalls = (mesh.face_queries ?? []).filter((_query, i) => {
      const data = mesh.face_data?.[i]
      if (data?.surface_type !== 'cylinderface') return false
      const radius = Math.hypot(data.centroid[0], data.centroid[1])
      return radius > 2.5 && radius < 3.5
    })
    expect(holeWalls).toHaveLength(4)
    const owners = holeWalls.map(faceOwnerOf)
    expect(owners.filter((owner) => owner === 'ex_mh')).toHaveLength(1)
    expect(owners.filter((owner) => owner === 'pat_mh')).toHaveLength(3)
    expect(owners).not.toContain('ex_base')

    const picked = selectByPredicate(
      { kind: 'face', where: { created_by: 'pat_mh', radius: 0.3125 } },
      r.bodies as unknown as Record<string, BodyResult>,
    )
    expect(picked.queries).toHaveLength(3)
  })

  it('focusrite: both tab tool bodies credit the copy, never the base extrude', () => {
    // One extrude whose sketch has two disjoint tab areas: the forced-new tool
    // solve returns two tool bodies, so a single copy is two applications. Only
    // per-application ownership records both halves of the copy.
    const r = h.run({
      features: [
        rectSketch('sk_plate', -100, -20, 600, 40),
        extrude('ex1', '$sk_plate', 5),
        { id: 'pl_top', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 5 } },
        // One sketch with two disjoint loops, so the forced-new tool solve
        // returns two tool bodies.
        {
          id: 'sk_tabs2', kind: 'sketch', plane: '@pl_top',
          entities: [
            { id: 'a0', kind: 'line' }, { id: 'a1', kind: 'line' }, { id: 'a2', kind: 'line' }, { id: 'a3', kind: 'line' },
            { id: 'b0', kind: 'line' }, { id: 'b1', kind: 'line' }, { id: 'b2', kind: 'line' }, { id: 'b3', kind: 'line' },
          ],
          initial: {
            a0: [-88, -2, -84, -2], a1: [-84, -2, -84, 2], a2: [-84, 2, -88, 2], a3: [-88, 2, -88, -2],
            b0: [84, -2, 88, -2], b1: [88, -2, 88, 2], b2: [88, 2, 84, 2], b3: [84, 2, 84, -2],
          },
          constraints: [
            { id: 'ca0', kind: 'coincident', a: { entity: 'a0', point: 'end' }, b: { entity: 'a1', point: 'start' } },
            { id: 'ca1', kind: 'coincident', a: { entity: 'a1', point: 'end' }, b: { entity: 'a2', point: 'start' } },
            { id: 'ca2', kind: 'coincident', a: { entity: 'a2', point: 'end' }, b: { entity: 'a3', point: 'start' } },
            { id: 'ca3', kind: 'coincident', a: { entity: 'a3', point: 'end' }, b: { entity: 'a0', point: 'start' } },
            { id: 'cb0', kind: 'coincident', a: { entity: 'b0', point: 'end' }, b: { entity: 'b1', point: 'start' } },
            { id: 'cb1', kind: 'coincident', a: { entity: 'b1', point: 'end' }, b: { entity: 'b2', point: 'start' } },
            { id: 'cb2', kind: 'coincident', a: { entity: 'b2', point: 'end' }, b: { entity: 'b3', point: 'start' } },
            { id: 'cb3', kind: 'coincident', a: { entity: 'b3', point: 'end' }, b: { entity: 'b0', point: 'start' } },
            { id: 'ha0', kind: 'horizontal', target: { entity: 'a0' } },
            { id: 'va1', kind: 'vertical', target: { entity: 'a1' } },
            { id: 'ha2', kind: 'horizontal', target: { entity: 'a2' } },
            { id: 'va3', kind: 'vertical', target: { entity: 'a3' } },
            { id: 'hb0', kind: 'horizontal', target: { entity: 'b0' } },
            { id: 'vb1', kind: 'vertical', target: { entity: 'b1' } },
            { id: 'hb2', kind: 'horizontal', target: { entity: 'b2' } },
            { id: 'vb3', kind: 'vertical', target: { entity: 'b3' } },
          ],
        },
        extrude('ex2', '$sk_tabs2', 3, 'add'),
        pattern('pa1', {
          subject: 'feature', source_feature: '@ex2',
          mode: 'linear', count: 2, pitch: 300, direction: [1, 0, 0],
        }),
      ],
    })
    expect(h.res(r, 'ex2').status).toBe('ok')
    expect(h.res(r, 'pa1').status).toBe('ok')
    const { edges, queries } = edgesOf(r, 'pa1', 'body_ex1')
    // Four corner edges per tab, and the copy has two tabs: at least eight copy
    // edges must answer to pa1.
    const copyEdges = queries.filter((query) => edgeIdsOf(query).includes('@pa1'))
    expect(copyEdges.length).toBeGreaterThanOrEqual(8)
    // The source tabs keep ex2.
    expect(queries.some((query) => edgeIdsOf(query).includes('@ex2'))).toBe(true)
    // No copy edge names the base extrude. A copy edge that fell back to the
    // body's creator would read @ex1 instead of @pa1.
    const tabEdges = edges.flatMap((edge, i) => {
      if (!('start' in edge) || !('end' in edge)) return []
      const x = (edge.start[0] + edge.end[0]) / 2
      const z = (edge.start[2] + edge.end[2]) / 2
      // The four vertical corner edges of each copy tab. Edges where a tab meets
      // the plate's top face are the plate's own boundary and stay ex1.
      return x > 200 && z > 5.5 && z < 7.5 ? [queries[i]] : []
    })
    expect(tabEdges.length).toBeGreaterThan(0)
    for (const query of tabEdges) {
      expect(edgeIdsOf(query)).not.toContain('@ex1')
      expect(edgeIdsOf(query)).toContain('@pa1')
    }
  })

  it('organiser collets: every pocket face answers a tool-side creator, none the blank', () => {
    const r = h.run({
      features: [
        rectSketch('sk_blank', -30, -30, 80, 80),
        extrude('ex1', '$sk_blank', 5),
        circleSketch('sk_c1', 5, 5, 2),
        extrude('rv1', '$sk_c1', 8),
        circleSketch('sk_c2', 5, 15, 1.5),
        extrude('rv2', '$sk_c2', 8),
        pattern('ar1', {
          subject: 'body', source_body: 'body_rv1', operation: 'new',
          mode: 'linear', count: 4, pitch: 10, direction: [1, 0, 0], include_source: true,
        }),
        pattern('ar2', {
          subject: 'body', source_body: 'body_rv2', operation: 'new',
          mode: 'linear', count: 4, pitch: 10, direction: [1, 0, 0], include_source: true,
        }),
        {
          id: 'b1', kind: 'boolean',
          boolean: { operation: 'subtract', target: 'body_ex1', tools: ['@ar1', '@ar2'] },
        },
      ],
    })
    expect(h.res(r, 'b1').status).toBe('ok')
    const mesh = facesOf(r, 'body_ex1')
    const pockets = (mesh.face_queries ?? []).filter((_q, i) => mesh.face_data?.[i]?.surface_type === 'cylinderface')
    expect(pockets).toHaveLength(8)
    for (const query of pockets) {
      const owners = edgeIdsOf(query)
      expect(owners).not.toContain('@ex1')
      expect(owners.some((token) => ['@rv1', '@rv2', '@ar1', '@ar2', '@b1'].includes(token))).toBe(true)
    }
  })

  it('80-20: a patterned cut face group answers to the pattern', () => {
    const r = h.run({
      features: [
        rectSketch('sk_block', 0, 0, 60, 20),
        extrude('ex1', '$sk_block', 5),
        rectSketch('sk_slot', 22, 8, 4, 4),
        extrude('ex2', '$sk_slot', 10, 'cut'),
        pattern('pt1', {
          subject: 'feature', source_feature: '@ex2',
          mode: 'circular', count: 4, step_angle: 90,
          axis_origin: [30, 10, 0], axis_direction: [0, 0, 1],
        }),
      ],
    })
    expect(h.res(r, 'pt1').status).toBe('ok')
    const wanted = selectByPredicate(
      { kind: 'edge', where: { created_by: 'pt1' } },
      r.bodies as unknown as Record<string, BodyResult>,
    )
    expect(wanted.queries.length).toBeGreaterThan(0)
    // The base extrude no longer returns the patterned slot edges.
    const base = selectByPredicate(
      { kind: 'edge', where: { created_by: 'ex1' } },
      r.bodies as unknown as Record<string, BodyResult>,
    )
    expect(base.queries.some((query) => edgeIdsOf(query).includes('@pt1'))).toBe(false)
  })
})
