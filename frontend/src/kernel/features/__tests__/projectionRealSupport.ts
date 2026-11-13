// @vitest-environment node
//
// One base document for the real-kernel projection pins: a 40 x 30 x 10 box on
// Top with an r3 hole through it on Front. Every scenario in the projection
// suite starts from this box, the same one the projection-review probes used.
//
// The body's element queries are looked up by GEOMETRY, never by index: a
// kernel change that reorders edges would otherwise retarget a projection test
// without changing a line of it. Predicates are the ones the probe read through
// `select`: the top-front edge has midpoint (20, 10, 0), the hole's front circle
// is centred at (20, 5, 0), and so on.
//
// Skips when OCC.js or the Rust solver is absent, through the shared extrude
// harness this fixture reuses.

import { extrudeTestHarness, extrudeSpec, rectSketchSk, oc } from '../extrudeRealSupport'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import type { SharedHarness } from '../../occ/sharedHarness'
import type { BuildResponse } from '../../builder'
import type { EdgeData, PartDoc } from '@/types/cad'
import type { OccShape } from '../../occ/occTypes'

export { oc, solveBytes } from '../extrudeRealSupport'

/** The box is built on Top, so its local y (30) becomes the world z depth and
 *  the extrusion distance is the world y height. */
export const BOX = { width: 40, height: 30, depth: 10 } as const
export const HOLE_CENTRE: [number, number] = [20, 5]
export const HOLE_RADIUS = 3

export const BOX_SKETCH_ID = 'sk1'
export const BOX_EXTRUDE_ID = 'ex1'
export const HOLE_SKETCH_ID = 'skh'
export const HOLE_EXTRUDE_ID = 'exh'
export const BOX_BODY_ID = `body_${BOX_EXTRUDE_ID}`

/** How far the body geometry is allowed to drift from the probe's numbers. The
 *  predicates name topology, not a solved value, so the tolerance is the
 *  kernel's own coincidence rung rather than a modelling slack. */
const TOL = 1e-6

type FaceDatumLike = {
  centroid: number[]
  normal: number[]
  surface_type: string
}

/** The base box plus its hole, in the live document format. `boxDepth` is the
 *  extrusion distance, so the follow-upstream case can rebuild the same
 *  document with a taller box. */
export function projectionBaseDoc(boxDepth: number = BOX.depth): PartDoc {
  const features = [
    rectSketchSk(BOX_SKETCH_ID, BOX.width, BOX.height, '@builtin_plane_top'),
    extrudeSpec(BOX_SKETCH_ID, BOX_EXTRUDE_ID, { distance: boxDepth, operation: 'new' }),
    {
      id: HOLE_SKETCH_ID, kind: 'sketch' as const, label: 'Hole',
      plane: '@builtin_plane_front',
      entities: [{ id: 'h1', kind: 'circle' as const }],
      initial: { h1: [...HOLE_CENTRE, HOLE_RADIUS] },
      constraints: [],
    },
    {
      id: HOLE_EXTRUDE_ID, kind: 'extrude' as const, label: 'Hole',
      extrude: {
        sketch: `@${HOLE_SKETCH_ID}`, distance: 10, direction: 'symmetric' as const,
        termination: 'through_all' as const, operation: 'cut' as const,
      },
    },
  ]
  return { version: 1, kind: 'part', features } as unknown as PartDoc
}

/** The base body's element queries, resolved once by geometry. */
export interface BaseGeometry {
  // The +y cap's front edge: world (0, depth, 0) to (width, depth, 0).
  topFrontEdge: string
  // The four straight edges bounding the +y cap, ordered by x then z so the
  // assignment of projected entity ids does not depend on kernel order.
  topFaceEdges: string[]
  // The cut opening at z = 0: centre (20, 5, 0), radius 3.
  holeFrontCircle: string
  // The flat face at z = 0 (outward normal +z).
  frontFace: string
  // The flat face at y = depth (outward normal +y).
  topFace: string
}

export interface ProjectionBase {
  result: BuildResponse
  geometry: BaseGeometry
}

export interface ProjectionHarness {
  h: SharedHarness
  // The one base build of this file, with its geometry-keyed queries.
  base: () => ProjectionBase
}

/** Wire the real harness and install the Rust solver; the base build happens on
 *  the first `base()` call so it can run after the file's `beforeAll`. */
export function projectionTestHarness(): ProjectionHarness {
  const h = extrudeTestHarness()
  let cached: ProjectionBase | null = null
  return {
    h,
    base: () => {
      if (cached === null) {
        const result = h.run(projectionBaseDoc() as unknown as Record<string, unknown>)
        cached = { result, geometry: readBaseGeometry(h, result) }
      }
      return cached
    },
  }
}

/** Volume of one body a feature produced, read from that feature's checkpoint. */
export function bodyVolume(h: SharedHarness, result: BuildResponse, extrudeId: string, bodyId: string): number {
  if (!oc) throw new Error('real OCC is required to measure a body')
  const store = result._build_state!.checkpoints[extrudeId].body_store_snapshot
  const scope = new DisposeScope()
  try {
    return volumeOf(oc, scope, h.table.get<OccShape>(store[bodyId].shape!))
  } finally {
    scope.dispose()
  }
}

function readBaseGeometry(h: SharedHarness, result: BuildResponse): BaseGeometry {
  const body = h.body(result, BOX_BODY_ID)
  const edges = (body.edges as EdgeData[]) ?? []
  const edgeQueries = (body.edge_queries as string[]) ?? []
  const mesh = (body.mesh ?? {}) as { face_queries?: string[]; face_data?: FaceDatumLike[] }
  const faceQueries = mesh.face_queries ?? []
  const faceData = mesh.face_data ?? []

  const lineMidpoint = (e: EdgeData): number[] | null => {
    if (e.kind !== 'line') return null
    return [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2, (e.start[2] + e.end[2]) / 2]
  }
  const topFrontEdge = only(
    edges.flatMap((e, i) => {
      const mid = lineMidpoint(e)
      return mid && near(mid, [BOX.width / 2, BOX.depth, 0]) ? [edgeQueries[i]] : []
    }),
    'top-front edge',
  )

  const topFaceEdges = edges.flatMap((e, i) => (
    e.kind === 'line'
      && Math.abs(e.start[1] - BOX.depth) <= TOL
      && Math.abs(e.end[1] - BOX.depth) <= TOL
      ? [edgeQueries[i]]
      : []
  ))
  return {
    topFrontEdge,
    topFaceEdges: sortEdgesByMidpoint(topFaceEdges, edges, edgeQueries),
    holeFrontCircle: only(
      edges.flatMap((e, i) => (
        (e.kind === 'circle' || e.kind === 'arc')
          && near(e.center, [...HOLE_CENTRE, 0])
          && Math.abs(e.radius - HOLE_RADIUS) <= TOL
          ? [edgeQueries[i]]
          : []
      )),
      'hole front circle',
    ),
    frontFace: onlyFace(faceQueries, faceData, (f) => f.normal[2] > 0.9 && Math.abs(f.centroid[2]) <= TOL, 'front face'),
    topFace: onlyFace(faceQueries, faceData, (f) => f.normal[1] > 0.9 && Math.abs(f.centroid[1] - BOX.depth) <= TOL, 'top face'),
  }
}

/** Order four cap edges by their midpoint so `w1..w4` land on the same world
 *  edges on every kernel build. */
function sortEdgesByMidpoint(queries: string[], edges: EdgeData[], edgeQueries: string[]): string[] {
  const midpointOf = new Map<string, number[]>()
  edges.forEach((e, i) => {
    if (e.kind !== 'line') return
    midpointOf.set(edgeQueries[i], [
      (e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2, (e.start[2] + e.end[2]) / 2,
    ])
  })
  return [...queries].sort((a, b) => {
    const ma = midpointOf.get(a) ?? [0, 0, 0]
    const mb = midpointOf.get(b) ?? [0, 0, 0]
    return ma[0] - mb[0] || ma[2] - mb[2]
  })
}

function only(queries: string[], what: string): string {
  if (queries.length !== 1) throw new Error(`base body: expected one ${what}, found ${queries.length}`)
  return queries[0]
}

function onlyFace(
  queries: string[],
  data: FaceDatumLike[],
  pred: (face: FaceDatumLike) => boolean,
  what: string,
): string {
  const found = queries.filter((_, i) => pred(data[i]))
  if (found.length !== 1) throw new Error(`base body: expected one ${what}, found ${found.length}`)
  return found[0]
}

function near(a: readonly number[], b: readonly number[], tol = TOL): boolean {
  return a.length >= b.length && b.every((v, i) => Math.abs(a[i] - v) <= tol)
}
