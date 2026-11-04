// @vitest-environment node
//
// The edge population a measure reports: `measureShape` must count the same
// edges `readSolidEdges` exposes to a pick and `select`. The probe decides the
// question: the Ex026 block (20 x 20 x 10, r2 on four vertical and four bottom
// edges) has four three-fillet sphere corners, and each corner leaves one
// degenerated edge that has no geometry to pick. Skips when opencascade.js is
// absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { HandleTable } from '../handleTable'
import { makeBox, makeCone } from '../primitives'
import { edgeToGeom, readSolidEdges } from '../primitives'
import { applyFilletWithLineage } from '../edgeModifier'
import { canonicalEdges, canonicalVertices } from '../bodyNames'
import { measureBodies, measureShape } from '../measure'
import { compareMeasures, type MeasureRow } from '../measureTolerance'
import { solidToEdges } from '../tessellation'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

function isVerticalLine(occ: OccModule, scope: DisposeScope, edge: OccShape): boolean {
  const { ed } = edgeToGeom(occ, scope, edge)
  if (ed.kind !== 'line') return false
  return ed.start[0] === ed.end[0] && ed.start[1] === ed.end[1] && ed.start[2] !== ed.end[2]
}

function isBottomLine(occ: OccModule, scope: DisposeScope, edge: OccShape): boolean {
  const { ed } = edgeToGeom(occ, scope, edge)
  return ed.kind === 'line' && ed.start[2] === 0 && ed.end[2] === 0
}

/** The eight Ex026 fillet edges: four vertical sides plus the bottom ring. */
function ex026FilletEdges(occ: OccModule, scope: DisposeScope, box: OccShape): OccShape[] {
  return canonicalEdges(occ, scope, box).filter(
    edge => isVerticalLine(occ, scope, edge) || isBottomLine(occ, scope, edge),
  )
}

function filletedBlock(occ: OccModule, scope: DisposeScope): OccShape {
  const box = makeBox(occ, scope, 20, 20, 10)
  const edges = ex026FilletEdges(occ, scope, box)
  expect(edges).toHaveLength(8)
  const res = applyFilletWithLineage(occ, scope, box, 2, edges)
  expect(res.success).toBe(true)
  return res.shape
}

/**
 * Endpoint distance of the edge's 3D curve. A degenerate edge's curve is a
 * point, so the span is zero; this corroborates `BRep_Tool.Degenerated`.
 */
function curveSpan(occ: OccModule, scope: DisposeScope, edge: OccShape): number {
  const ad = scope.track(new occ.BRepAdaptor_Curve_2(edge))
  const first = ad.Value(ad.FirstParameter())
  const last = ad.Value(ad.LastParameter())
  const span = Math.hypot(first.X() - last.X(), first.Y() - last.Y(), first.Z() - last.Z())
  first.delete()
  last.delete()
  return span
}

function row(rows: MeasureRow[], measure: MeasureRow['measure']): MeasureRow {
  const found = rows.find((r) => r.measure === measure)
  if (!found) throw new Error(`no ${measure} row`)
  return found
}

describe.skipIf(!oc)('measure edge population (real OCC)', () => {
  it('pins the Ex026 population: 40 canonical, 4 degenerated, 36 pickable', () => {
    const scope = new DisposeScope()
    try {
      const shape = filletedBlock(oc!, scope)
      const canonical = canonicalEdges(oc!, scope, shape)
      const pickable = readSolidEdges(oc!, scope, shape)
      const degenerated = canonical.filter(edge => oc!.BRep_Tool.Degenerated?.(edge) ?? false)
      const measure = measureShape(oc!, scope, shape)

      expect(canonical).toHaveLength(40)
      expect(pickable).toHaveLength(36)
      expect(degenerated).toHaveLength(4)
      expect(canonical.length - pickable.length).toBe(degenerated.length)
      // Every corner patch's extra edge is a spline collapsed to a point, which
      // is exactly what the pick surface skips and what the count must drop.
      for (const edge of degenerated) {
        expect(edgeToGeom(oc!, scope, edge).ed.kind).toBe('spline')
        expect(curveSpan(oc!, scope, edge)).toBeCloseTo(0, 9)
      }

      expect(measure.faces).toBe(18)
      expect(measure.edges).toBe(36)
      expect(measure.vertices).toBe(20)
    } finally {
      scope.dispose()
    }
  })

  it('measure and the pick surface agree for one body', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const shape = filletedBlock(oc!, scope)
      const handle = table.register(shape, 'fillet1')
      const { edges, edge_queries } = solidToEdges(oc!, table, handle, {
        createdBy: 'fillet1', bodyId: '@body_1',
      })
      const measure = measureShape(oc!, scope, shape)
      expect(edges).toHaveLength(36)
      expect(edge_queries).toHaveLength(36)
      expect(edges.length).toBe(measure.edges)
      expect(edge_queries.length).toBe(measure.edges)
    } finally {
      scope.dispose()
    }
  })

  it('leaves a plain box alone: no degenerated edges, counts unchanged', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(oc!, scope, 20, 20, 10)
      const canonical = canonicalEdges(oc!, scope, box)
      const pickable = readSolidEdges(oc!, scope, box)
      const measure = measureShape(oc!, scope, box)
      expect(canonical).toHaveLength(12)
      expect(pickable).toHaveLength(12)
      expect(measure.faces).toBe(6)
      expect(measure.edges).toBe(12)
      expect(measure.vertices).toBe(8)
    } finally {
      scope.dispose()
    }
  })

  it('drops a cone apex edge from edges but keeps the apex vertex once', () => {
    const scope = new DisposeScope()
    try {
      const cone = scope.track(makeCone(oc!, scope, [0, 0, 0], [0, 0, 1], 0, 5, 10))
      const canonical = canonicalEdges(oc!, scope, cone)
      const degenerated = canonical.filter(edge => oc!.BRep_Tool.Degenerated?.(edge) ?? false)
      const pickable = readSolidEdges(oc!, scope, cone)
      const measure = measureShape(oc!, scope, cone)
      // The fixture must really contain an apex edge, or this test proves nothing.
      expect(degenerated.length).toBeGreaterThan(0)
      expect(measure.edges).toBe(pickable.length)
      expect(measure.edges).toBe(canonical.length - degenerated.length)

      const vertices = canonicalVertices(oc!, scope, cone)
      const atOrigin = vertices.filter((vertex) => {
        const pnt = oc!.BRep_Tool.Pnt(vertex)
        const at = pnt.X() === 0 && pnt.Y() === 0 && pnt.Z() === 0
        pnt.delete()
        return at
      })
      expect(atOrigin).toHaveLength(1)
      expect(measure.vertices).toBe(vertices.length)
    } finally {
      scope.dispose()
    }
  })

  it('enforces the filtered count in strict mode and reports it in report mode', () => {
    const scope = new DisposeScope()
    try {
      const shape = filletedBlock(oc!, scope)
      const measure = measureBodies(oc!, scope, [shape])
      const reference = { bodies: 1, faces: 18, edges: 36 }
      expect(compareMeasures(measure, reference, { topology: 'strict' }).pass).toBe(true)

      const stale = { bodies: 1, faces: 18, edges: 40 }
      const strict = compareMeasures(measure, stale, { topology: 'strict' })
      expect(strict.pass).toBe(false)
      expect(row(strict.rows, 'edges').within).toBe(false)
      expect(row(strict.rows, 'edges').enforced).toBe(true)

      const report = compareMeasures(measure, stale, { topology: 'report' })
      expect(report.pass).toBe(true)
      expect(row(report.rows, 'edges').within).toBe(false)
      expect(row(report.rows, 'edges').enforced).toBe(false)
    } finally {
      scope.dispose()
    }
  })
})
