// @vitest-environment node
//
// Projection correctness on an ASYMMETRIC box (8 x 12 x 5, all dims distinct).
// A symmetric cube hides transform bugs: an X<->Y axis swap or a transposed
// plane basis produces identical numbers on a square cross-section, so it can
// pass while real projections land in the wrong place. With three distinct
// edge lengths every axis confusion shows up as a coordinate mismatch.
//
// For each body edge we know its world endpoints (EdgeData). We project those
// endpoints onto each builtin sketch plane analytically (the plane's own basis)
// and assert the kernel's projected sketch geometry matches, endpoints in any
// order. The sketcher must place a projected edge exactly where the plane frame
// puts it -- not merely "somewhere".
//
// Skips when OCC.js or the Rust solver is absent.
//
// SCOPE / STILL NEEDS VISUAL + HUMAN VERIFICATION:
// This test proves the KERNEL projection math is correct (coordinate-exact on
// builtin planes AND on a derived offset face plane). It deliberately bypasses
// the live UI: it constructs the projected entity directly and reads the solver
// output. It therefore does NOT reproduce the reported "yellow cross lands in
// the wrong place" bug, which lives in the live pick/render path (the hover
// feature handed the project tool a `:vertex` query, which lowers to a point at
// a corner; and/or the 3D render placement). Confirming the actual fix REQUIRES
// running the app and visually checking that a picked edge projects onto the
// sketch where the user aimed. Green here is necessary, not sufficient.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, setSketchTopology, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { BUILTIN_PLANES } from '../solverConstants'
import type { EdgeData } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()
const topologyBytes = loadTopology()

type Vec3 = [number, number, number]
type PlaneBasis = { origin: number[]; x_axis: number[]; y_axis: number[] }

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// World point -> 2D sketch-local coordinates on the given plane.
function toLocal(p: Vec3, plane: PlaneBasis): [number, number] {
  const d: Vec3 = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]]
  return [dot(d, plane.x_axis), dot(d, plane.y_axis)]
}

function close(a: number, b: number, eps = 1e-6) { return Math.abs(a - b) <= eps }

// A projected line [x1,y1,x2,y2] matches the expected endpoint pair in either order.
function lineMatches(got: number[], e0: [number, number], e1: [number, number]): boolean {
  const g0: [number, number] = [got[0], got[1]]
  const g1: [number, number] = [got[2], got[3]]
  const same = (a: [number, number], b: [number, number]) => close(a[0], b[0]) && close(a[1], b[1])
  return (same(g0, e0) && same(g1, e1)) || (same(g0, e1) && same(g1, e0))
}

const W = 8, H = 12, D = 5  // distinct on every axis

function rectSketch() {
  return {
    id: 'sk1', kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, W, 0], right: [W, 0, W, H], top: [W, H, 0, H], left: [0, H, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: W },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: H },
    ],
  }
}

describe.skipIf(!oc || !solveBytes || !topologyBytes)('project asymmetric box edges (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  let edgeQueries: string[] = []
  let edges: EdgeData[] = []
  let r1: ReturnType<SharedHarness['run']>

  beforeAll(() => {
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
    if (topologyBytes) setSketchTopology(topologyBytes)
    const ex1 = { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: D, direction: 'normal', operation: 'add' }
    r1 = h.run({ features: [rectSketch(), ex1] })
    expect(h.res(r1, 'ex1').status).toBe('ok')
    edgeQueries = (h.body(r1, 'body_ex1').edge_queries as string[]) ?? []
    edges = (h.body(r1, 'body_ex1').edges as EdgeData[]) ?? []
    expect(edgeQueries.length).toBeGreaterThan(0)
    expect(edges.length).toBe(edgeQueries.length)
  })

  for (const planeQuery of ['@builtin_plane_front', '@builtin_plane_top', '@builtin_plane_right']) {
    it(`every line edge projects to its true plane-local coordinates on ${planeQuery}`, () => {
      const plane = BUILTIN_PLANES[planeQuery.slice(1)] as PlaneBasis
      const mismatches: string[] = []

      edges.forEach((ed, i) => {
        if (ed.kind !== 'line') return  // a box has only straight edges
        const eStart = toLocal(ed.start, plane)
        const eEnd = toLocal(ed.end, plane)

        const sk2 = {
          id: 'sk2', kind: 'sketch' as const, plane: planeQuery,
          entities: [{ id: 'proj0', kind: 'line' as const, source: edgeQueries[i] }],
          initial: {}, constraints: [],
        }
        const r2 = h.run({ features: [rectSketch(), { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: D, direction: 'normal', operation: 'add' }, sk2] }, { prevState: r1._build_state })
        const sk2res = h.res(r2, 'sk2')

        const projErrors = (sk2res.projection_errors as string[]) ?? []
        const geom = (sk2res.geometry as Record<string, number[]>)?.proj0
        if (projErrors.includes('proj0') || !geom) {
          mismatches.push(`edge ${i}: DROPPED (projErr=${JSON.stringify(projErrors)})`)
          return
        }
        if (!lineMatches(geom, eStart, eEnd)) {
          mismatches.push(
            `edge ${i}: world ${JSON.stringify(ed.start)}->${JSON.stringify(ed.end)} ` +
            `expected local ${JSON.stringify(eStart)}->${JSON.stringify(eEnd)} got ${JSON.stringify(geom)}`
          )
        }
      })

      expect(mismatches, `\n${mismatches.join('\n')}`).toEqual([])
    })
  }

  // The real workflow: a sketch placed ON A BODY FACE (a derived `?...:flatface`
  // plane with a real origin offset and basis), then an edge projected onto it.
  // A builtin plane sits at the world origin, so a "project onto the wrong plane"
  // bug stays hidden there. A face plane is offset and rotated, so the projected
  // sketch coordinates MUST agree with the plane_transform the renderer uses to
  // place the sketch in 3D -- otherwise the drawn entity lands away from the edge.
  it('an edge projects consistently with the on-face sketch plane it is drawn on', () => {
    const mesh = (h.body(r1, 'body_ex1').mesh as { face_queries?: string[]; face_data?: { normal: number[]; centroid: number[] }[] }) ?? {}
    const faceQueries = mesh.face_queries ?? []
    const faceData = mesh.face_data ?? []
    // Pick a side face whose plane is offset from the world origin (e.g. +X face
    // at x=W): its origin is non-zero, so an identity/wrong-plane projection fails.
    let faceQuery: string | null = null
    for (let i = 0; i < faceData.length; i++) {
      if (faceData[i].normal[0] > 0.9) { faceQuery = faceQueries[i] ?? null; break }
    }
    expect(faceQuery, 'expected a +X side face on the box').toBeTruthy()

    const ex1 = { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: D, direction: 'normal', operation: 'add' }
    const mismatches: string[] = []
    edges.forEach((ed, i) => {
      if (ed.kind !== 'line') return
      const sk2 = {
        id: 'sk2', kind: 'sketch' as const, plane: faceQuery!,
        entities: [{ id: 'proj0', kind: 'line' as const, source: edgeQueries[i] }],
        initial: {}, constraints: [],
      }
      const r2 = h.run({ features: [rectSketch(), ex1, sk2] }, { prevState: r1._build_state })
      const sk2res = h.res(r2, 'sk2')
      if (sk2res.status === 'exception') { mismatches.push(`edge ${i}: sk2 exception ${JSON.stringify(sk2res.exception)}`); return }

      const pt = sk2res.plane_transform as { rotation: number[]; origin: number[] } | undefined
      if (!pt) { mismatches.push(`edge ${i}: no plane_transform on face sketch`); return }
      const facePlane: PlaneBasis = {
        origin: pt.origin,
        x_axis: pt.rotation.slice(0, 3),
        y_axis: pt.rotation.slice(3, 6),
      }
      const eStart = toLocal(ed.start, facePlane)
      const eEnd = toLocal(ed.end, facePlane)

      const geom = (sk2res.geometry as Record<string, number[]>)?.proj0
      const projErrors = (sk2res.projection_errors as string[]) ?? []
      if (projErrors.includes('proj0') || !geom) { mismatches.push(`edge ${i}: DROPPED (projErr=${JSON.stringify(projErrors)})`); return }
      if (!lineMatches(geom, eStart, eEnd)) {
        mismatches.push(
          `edge ${i}: world ${JSON.stringify(ed.start)}->${JSON.stringify(ed.end)} ` +
          `expected face-local ${JSON.stringify(eStart)}->${JSON.stringify(eEnd)} got ${JSON.stringify(geom)}`
        )
      }
    })
    expect(mismatches, `\n${mismatches.join('\n')}`).toEqual([])
  })
})
