// @vitest-environment node
//
// Real-OCC guard for the viewport's hidden seam lists: a periodic face closes
// on itself along a seam edge, and every closed edge carries one vertex that
// ends nowhere. Both are kernel bookkeeping, so `hiddenSubShapeIndices` names
// them as sparse indices beside the ordinary arrays; the arrays themselves are
// the pre-feature result, byte for byte.
//
// Skips when opencascade.js is absent. Install:
//   cd frontend && npm run occ:install

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { HandleTable } from '../handleTable'
import { buildBox, buildCylinder, buildProfileExtrude } from '../shapes'
import { makeBox, makeCylinder } from '../primitives'
import { booleanWithDiff } from '../booleans'
import { stepBytesToShapeWithIdentity } from '../stepIo'
import {
  hiddenSubShapeIndices,
  solidToEdges,
  solidToFaceEdgeQueries,
  solidToMesh,
  solidToVertices,
} from '../tessellation'
import { tessellateBodies } from '../../solveLocally'
import { toPartBundle } from '../../partBundle'
import type { OccModule } from '../occTypes'
import type { OccHandle } from '../handleTable'
import type { Body } from '../../types3d'
import type { BodyResult } from '../../../types/cad'

const oc = await loadOcc()

function makeBody(id: string, createdBy: string, shapeHandle: OccHandle | null): Body {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape: shapeHandle,
    sketch_id: '',
    brep_diff: null,
    profile_queries: [],
  }
}

describe.skipIf(!oc)('hidden seam indices (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function cylinder(table: HandleTable): OccHandle {
    return buildCylinder(occ, table, { center: [0, 0, 0], axis: [0, 0, 1], radius: 5, height: 10 })
  }

  // A through hole in a 10 x 6 x 4 plate: the hole wall is the only periodic
  // face, so its seam is the only hidden edge and its two rim vertices the only
  // hidden vertices.
  function plateWithHole(table: HandleTable): OccHandle {
    const scope = new DisposeScope()
    try {
      const plate = makeBox(occ, scope, 10, 6, 4)
      // Taller than the plate, centred on it, so the cut goes clean through.
      const drill = makeCylinder(occ, scope, [5, 3, -1], [0, 0, 1], 1.2, 6)
      return table.register(booleanWithDiff(occ, scope, plate, drill, 'cut').shape)
    } finally {
      scope.dispose()
    }
  }

  function sphere(table: HandleTable): OccHandle {
    const scope = new DisposeScope()
    try {
      const centre = scope.track(new occ.gp_Pnt_3(0, 0, 0))
      const builder = scope.track(new occ.BRepPrimAPI_MakeSphere_5(centre, 5))
      return table.register(builder.Shape())
    } finally {
      scope.dispose()
    }
  }

  // Extruded semicircle: the curved wall is not a closed surface, so there is no
  // seam. Guards against hiding by surface type instead of by topology.
  function halfCylinder(table: HandleTable): OccHandle {
    return buildProfileExtrude(occ, table, {
      edges: [
        {
          kind: 'arc', center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0],
          radius: 5, angleStart: 0, angleEnd: Math.PI,
        },
        { kind: 'line', start: [-5, 0, 0], end: [5, 0, 0] },
      ],
      direction: [0, 0, 1],
      distance: 8,
    })
  }

  it('hides exactly the lateral seam of an extruded circle', () => {
    const table = new HandleTable()
    const handle = cylinder(table)
    try {
      const { edges } = solidToEdges(occ, table, handle, { createdBy: 'cyl1' })
      const { vertices } = solidToVertices(occ, table, handle, { createdBy: 'cyl1' })
      const hidden = hiddenSubShapeIndices(occ, table, handle)

      expect(hidden.hidden_edges).toHaveLength(1)
      const seam = edges[hidden.hidden_edges[0]]
      expect(seam.kind).toBe('line')
      expect(seam.kind === 'line' && Math.abs(seam.end[2] - seam.start[2])).toBeCloseTo(10, 9)
      // Both rims stay visible.
      expect(edges.filter(e => e.kind === 'circle')).toHaveLength(2)

      // Both vertices sit on the seam, so neither ends an open visible edge.
      expect(vertices).toHaveLength(2)
      expect([...hidden.hidden_vertices].sort()).toEqual([0, 1])

      // The assembly bundle carries the same lists, so a cached part rebuild
      // hides them there too. `tessellateBodies` types its payload as a loose
      // record; the shape it assembles is a BodyResult.
      const body = makeBody('body_cyl', 'cyl1', handle)
      const payload = tessellateBodies(occ, table, { body_cyl: body }) as unknown as Record<string, BodyResult>
      const bundle = toPartBundle('doc', 'hash', payload)
      expect(bundle.bodies[0].hiddenEdges).toEqual(hidden.hidden_edges)
      expect(bundle.bodies[0].hiddenVertices).toEqual(hidden.hidden_vertices)
    } finally {
      table.release(handle)
      table.assertNoLeaks()
    }
  })

  it('hides nothing on a box', () => {
    const table = new HandleTable()
    const handle = buildBox(occ, table, { dx: 10, dy: 6, dz: 4 })
    try {
      const hidden = hiddenSubShapeIndices(occ, table, handle)
      expect(hidden.hidden_edges).toEqual([])
      expect(hidden.hidden_vertices).toEqual([])
    } finally {
      table.release(handle)
      table.assertNoLeaks()
    }
  })

  it('hides the hole seam and its rim vertices on a plate with a through hole', () => {
    const table = new HandleTable()
    const handle = plateWithHole(table)
    try {
      const { edges } = solidToEdges(occ, table, handle, { createdBy: 'plate1' })
      const { vertices } = solidToVertices(occ, table, handle, { createdBy: 'plate1' })
      const hidden = hiddenSubShapeIndices(occ, table, handle)

      expect(hidden.hidden_edges).toHaveLength(1)
      expect(edges[hidden.hidden_edges[0]].kind).toBe('line')

      // 8 plate corners + the 2 hole-rim vertices the seam ends on.
      expect(vertices).toHaveLength(10)
      expect(hidden.hidden_vertices).toHaveLength(2)
      const hiddenPositions = hidden.hidden_vertices.map(i => vertices[i])
      for (const p of hiddenPositions) {
        // On the drilled radius, at the plate's two faces.
        expect(Math.hypot(p[0] - 5, p[1] - 3)).toBeCloseTo(1.2, 6)
        expect(Math.min(Math.abs(p[2]), Math.abs(p[2] - 4))).toBeCloseTo(0, 6)
      }
      // Every corner is vouched for by the plate's open edges.
      const visible = vertices.filter((_v, i) => !hidden.hidden_vertices.includes(i))
      expect(visible).toHaveLength(8)
      for (const p of visible) {
        expect(Math.min(Math.abs(p[0]), Math.abs(p[0] - 10))).toBeCloseTo(0, 6)
        expect(Math.min(Math.abs(p[1]), Math.abs(p[1] - 6))).toBeCloseTo(0, 6)
      }
    } finally {
      table.release(handle)
      table.assertNoLeaks()
    }
  })

  it('hides the sphere seam and both poles, and emits no visible edge', () => {
    const table = new HandleTable()
    const handle = sphere(table)
    try {
      const { edges } = solidToEdges(occ, table, handle, { createdBy: 'sph1' })
      const { vertices } = solidToVertices(occ, table, handle, { createdBy: 'sph1' })
      // The two degenerate pole edges are already dropped by readSolidEdges.
      expect(edges).toHaveLength(1)
      const hidden = hiddenSubShapeIndices(occ, table, handle)
      expect(hidden.hidden_edges).toEqual([0])
      // Both pole vertices end no visible open edge (the seam is hidden).
      expect(vertices).toHaveLength(2)
      expect([...hidden.hidden_vertices].sort()).toEqual([0, 1])
    } finally {
      table.release(handle)
      table.assertNoLeaks()
    }
  })

  it('keeps everything on a half cylinder: the curved wall is not a closed surface', () => {
    const table = new HandleTable()
    const handle = halfCylinder(table)
    try {
      const { edges } = solidToEdges(occ, table, handle, { createdBy: 'half1' })
      expect(edges).toHaveLength(6)
      const hidden = hiddenSubShapeIndices(occ, table, handle)
      expect(hidden.hidden_edges).toEqual([])
      expect(hidden.hidden_vertices).toEqual([])
      expect(solidToVertices(occ, table, handle, { createdBy: 'half1' }).vertices).toHaveLength(4)
    } finally {
      table.release(handle)
      table.assertNoLeaks()
    }
  })

  // The invariance proof at unit scale: the sparse lists are the ONLY addition.
  // The five arrays below are rebuilt from the per-array producers on the same
  // solid, which know nothing about the classification, and must match what
  // tessellateBodies emitted byte for byte.
  it('leaves every name, query and positional array byte-identical', () => {
    const fixtures: Array<[string, (table: HandleTable) => OccHandle]> = [
      ['box', (table) => buildBox(occ, table, { dx: 10, dy: 6, dz: 4 })],
      ['cylinder', cylinder],
      ['hole', plateWithHole],
      ['sphere', sphere],
      ['half', halfCylinder],
    ]
    for (const [label, make] of fixtures) {
      const table = new HandleTable()
      const handle = make(table)
      try {
        const body = makeBody(`body_${label}`, 'f1', handle)
        const result = tessellateBodies(occ, table, { [body.id]: body })[body.id] as {
          edges?: unknown
          edge_queries?: unknown
          vertices?: unknown
          vertex_queries?: unknown
          mesh?: { face_seam_queries?: unknown; face_queries?: unknown }
        }
        expect(result, label).toBeDefined()

        // The same options tessellateBodies passes, so the control is the
        // pre-feature result exactly.
        const base = {
          createdBy: 'f1',
          bodyId: body.id,
          profileQueries: [] as string[],
          newElements: null,
          modifiedBy: body.modified_by,
        }
        const controlEdges = solidToEdges(occ, table, handle, { ...base, computeConvexity: true })
        const controlVertices = solidToVertices(occ, table, handle, base)
        const controlMesh = solidToMesh(occ, table, handle, base)
        const controlSeams = solidToFaceEdgeQueries(occ, table, handle, controlEdges.edge_queries)

        expect(result.edges, label).toEqual(controlEdges.edges)
        expect(result.edge_queries, label).toEqual(controlEdges.edge_queries)
        expect(result.vertices, label).toEqual(controlVertices.vertices)
        expect(result.vertex_queries, label).toEqual(controlVertices.vertex_queries)
        expect(result.mesh?.face_seam_queries, label).toEqual(controlSeams.face_seam_queries)
        expect(result.mesh?.face_queries, label).toEqual(controlMesh.face_queries)
      } finally {
        table.release(handle)
        table.assertNoLeaks()
      }
    }
  })

  it('classifies an imported STEP fixture by the same rule', () => {
    const bytes = new Uint8Array(readFileSync(new URL('../__fixtures__/double_with_hole.step', import.meta.url)))
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { shape } = stepBytesToShapeWithIdentity(occ, scope, bytes)
      const handle = table.register(shape)
      const { edges, edge_queries } = solidToEdges(occ, table, handle, { createdBy: 'import1' })
      const { face_seam_queries } = solidToFaceEdgeQueries(occ, table, handle, edge_queries)
      const hidden = hiddenSubShapeIndices(occ, table, handle)

      // The fixture has cylindrical hole walls, so it must exercise the rule.
      expect(hidden.hidden_edges.length).toBeGreaterThan(0)
      const seamQueries = new Set(face_seam_queries.flat())
      const hiddenQueries = new Set(hidden.hidden_edges.map(i => edge_queries[i]))
      expect(hiddenQueries).toEqual(seamQueries)
      for (const i of hidden.hidden_edges) expect(edges[i].kind).toBe('line')
      table.release(handle)
    } finally {
      scope.dispose()
      table.assertNoLeaks()
    }
  })
})
