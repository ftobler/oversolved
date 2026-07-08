import { describe, it, expect } from 'vitest'
import { toEdgeCurve, toBodyMesh, toPartBundle, extractBodyAnchors } from './partBundle'
import type { EdgeData, BodyResult } from '../types/cad'

describe('toEdgeCurve', () => {
  it('converts a line edge to an EdgeCurve with midpoint + normalized axis + endpoints', () => {
    const ed: EdgeData = {
      kind: 'line',
      start: [0, 0, 0],
      end: [10, 0, 0],
    }
    const curve = toEdgeCurve(ed, '@gde|10,0,5|1,0,0')
    expect(curve.id).toBe('@gde|10,0,5|1,0,0')
    expect(curve.kind).toBe('line')
    expect(curve.point[0]).toBeCloseTo(5)
    expect(curve.point[1]).toBeCloseTo(0)
    expect(curve.point[2]).toBeCloseTo(0)
    expect(curve.axis![0]).toBeCloseTo(1)
    expect(curve.axis![1]).toBeCloseTo(0)
    expect(curve.axis![2]).toBeCloseTo(0)
    expect(curve.radius).toBeUndefined()
    expect(curve.endpoints[0]).toEqual([0, 0, 0])
    expect(curve.endpoints[1]).toEqual([10, 0, 0])
  })

  it('converts a circular arc edge with correct endpoints', () => {
    const ed: EdgeData = {
      kind: 'arc',
      center: [0, 0, 0],
      radius: 5,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: Math.PI / 2,
    }
    const curve = toEdgeCurve(ed, '@gde|arc1')
    expect(curve.kind).toBe('circle')
    expect(curve.point).toEqual([0, 0, 0])
    expect(curve.axis).toEqual([0, 0, 1])
    expect(curve.radius).toBe(5)
    // Start at angle 0: point on +X axis at radius 5
    expect(curve.endpoints[0][0]).toBeCloseTo(5)
    expect(curve.endpoints[0][1]).toBeCloseTo(0)
    expect(curve.endpoints[0][2]).toBeCloseTo(0)
    // End at angle pi/2: point on +Y axis at radius 5
    expect(curve.endpoints[1][0]).toBeCloseTo(0)
    expect(curve.endpoints[1][1]).toBeCloseTo(5)
    expect(curve.endpoints[1][2]).toBeCloseTo(0)
  })

  it('converts a full circle edge with endpoints at the same point', () => {
    const ed: EdgeData = {
      kind: 'circle',
      center: [0, 0, 0],
      radius: 3,
      axis: [0, 1, 0],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: 2 * Math.PI,
    }
    const curve = toEdgeCurve(ed, '@gde|full_circle')
    expect(curve.kind).toBe('circle')
    expect(curve.point).toEqual([0, 0, 0])
    expect(curve.radius).toBe(3)
    expect(curve.axis).toEqual([0, 1, 0])
    // Full circle endpoints coincide at the same point on the circle
    expect(curve.endpoints[0][0]).toBeCloseTo(curve.endpoints[1][0])
    expect(curve.endpoints[0][1]).toBeCloseTo(curve.endpoints[1][1])
    expect(curve.endpoints[0][2]).toBeCloseTo(curve.endpoints[1][2])
  })

  it('converts an ellipse edge', () => {
    const ed: EdgeData = {
      kind: 'ellipse',
      center: [10, 20, 30],
      a: 4,
      b: 2,
      axis: [0, 0, 1],
      x_axis: [1, 0, 0],
      angle_start: 0,
      angle_end: Math.PI / 2,
    }
    const curve = toEdgeCurve(ed, 'ell1')
    expect(curve.kind).toBe('ellipse')
    expect(curve.point).toEqual([10, 20, 30])
    expect(curve.axis).toEqual([0, 0, 1])
    expect(curve.radius).toBe(4)
    // Start at eccentric angle 0: point at center + (a,0,0)
    expect(curve.endpoints[0][0]).toBeCloseTo(14)
    expect(curve.endpoints[0][1]).toBeCloseTo(20)
    expect(curve.endpoints[0][2]).toBeCloseTo(30)
    // End at eccentric angle pi/2: point at center + (0,b,0)
    expect(curve.endpoints[1][0]).toBeCloseTo(10)
    expect(curve.endpoints[1][1]).toBeCloseTo(22)
    expect(curve.endpoints[1][2]).toBeCloseTo(30)
  })

  it('converts a spline edge', () => {
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [1, 2, 0],
      [2, 3, 0],
      [4, 1, 0],
    ]
    const ed: EdgeData = {
      kind: 'spline',
      points: pts,
    }
    const curve = toEdgeCurve(ed, 'spline1')
    expect(curve.kind).toBe('b-spline')
    // Midpoint of 4 points -> index 2
    expect(curve.point).toEqual([2, 3, 0])
    expect(curve.axis).toBeUndefined()
    expect(curve.radius).toBeUndefined()
    expect(curve.endpoints[0]).toEqual([0, 0, 0])
    expect(curve.endpoints[1]).toEqual([4, 1, 0])
  })
})

describe('toBodyMesh', () => {
  it('converts a BodyResult with tuple mesh into typed arrays', () => {
    const body: BodyResult = {
      id: 'body_1',
      created_by: 'ex1',
      modified_by: [],
      mesh: {
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces: [[0, 1, 2]],
        triangle_to_face: [0],
        face_queries: ['@gdf|...'],
      },
      edges: [],
      edge_queries: [],
    }
    const result = toBodyMesh(body)
    expect(result.mesh.vertices).toBeInstanceOf(Float32Array)
    expect(result.mesh.indices).toBeInstanceOf(Uint32Array)
    expect(result.mesh.faceIdsPerTriangle).toBeInstanceOf(Uint32Array)
    expect(Array.from(result.mesh.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(result.mesh.indices)).toEqual([0, 1, 2])
    expect(Array.from(result.mesh.faceIdsPerTriangle)).toEqual([0])
    expect(result.edges).toEqual([])
  })

  it('converts edges from the body into EdgeCurves', () => {
    const body: BodyResult = {
      id: 'body_2',
      created_by: 'ex2',
      modified_by: [],
      mesh: {
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces: [[0, 1, 2]],
      },
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
        { kind: 'line', start: [10, 0, 0], end: [10, 5, 0] },
      ],
      edge_queries: ['@gde|line1', '@gde|line2'],
    }
    const result = toBodyMesh(body)
    expect(result.edges).toHaveLength(2)
    expect(result.edges[0].kind).toBe('line')
    expect(result.edges[0].id).toBe('@gde|line1')
    expect(result.edges[1].kind).toBe('line')
    expect(result.edges[1].id).toBe('@gde|line2')
  })

  it('handles a body with no mesh (produces empty typed arrays)', () => {
    const body: BodyResult = {
      id: 'body_3',
      created_by: 'ex3',
      modified_by: [],
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [5, 0, 0] },
      ],
      edge_queries: ['@gde|only_edge'],
    }
    const result = toBodyMesh(body)
    expect(result.mesh.vertices).toBeInstanceOf(Float32Array)
    expect(result.mesh.vertices.length).toBe(0)
    expect(result.mesh.indices.length).toBe(0)
    expect(result.mesh.faceIdsPerTriangle.length).toBe(0)
    expect(result.edges).toHaveLength(1)
  })

  it('handles a body with no triangle_to_face (zero-filled faceIdsPerTriangle)', () => {
    const body: BodyResult = {
      id: 'body_4',
      created_by: 'ex4',
      modified_by: [],
      mesh: {
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces: [[0, 1, 2]],
      },
    }
    const result = toBodyMesh(body)
    expect(result.mesh.faceIdsPerTriangle.length).toBe(1)
    expect(result.mesh.faceIdsPerTriangle[0]).toBe(0)
  })
})

describe('toPartBundle', () => {
  it('converts a Record of BodyResults into a PartBundle with anchors', () => {
    const bodies: Record<string, BodyResult> = {
      body_1: {
        id: 'body_1',
        created_by: 'ex1',
        modified_by: [],
        mesh: { vertices: [[0, 0, 0]], faces: [[0, 0, 0]] },
      },
      body_2: {
        id: 'body_2',
        created_by: 'ex2',
        modified_by: [],
        mesh: { vertices: [[1, 1, 1]], faces: [[0, 0, 0]] },
        edges: [{ kind: 'line', start: [0, 0, 0], end: [1, 1, 1] }],
        edge_queries: ['edge1'],
      },
    }
    const bundle = toPartBundle('doc123', 5, bodies)
    expect(bundle.doc_id).toBe('doc123')
    expect(bundle.doc_rev).toBe(5)
    expect(bundle.bodies).toHaveLength(2)
    expect(bundle.bodies[1].edges).toHaveLength(1)
    // Anchors populated (empty for these no-query mock bodies)
    expect(typeof bundle.anchors).toBe('object')
    expect(Object.keys(bundle.anchors).length).toBeGreaterThanOrEqual(0)
  })
})

// ── Anchor extraction (Stage 2c) ─────────────────────────────────────────

/** Build a query string in the ancestry format that `findDescriptorInQuery` can parse. */
function makeQuery(ids: string[], typeRestriction: string | null): string {
  const hexLengths = ids.map((id) => id.length.toString(16)).join(',')
  const body = ids.join('')
  return typeRestriction ? `?${hexLengths};${body}:${typeRestriction}` : `?${hexLengths};${body}`
}

const EX_FEATURE = 'ex123'

describe('extractBodyAnchors', () => {
  function mintFactory(): () => string {
    let n = 0
    return () => { n++; return `a${n}` }
  }

  it('emits face anchors for flatface, cylinderface, coneface, sphereface, torusface', () => {
    const types: [string, string][] = [
      ['flatface', 'plane'],
      ['cylinderface', 'cylinder'],
      ['coneface', 'cone'],
      ['sphereface', 'sphere'],
      ['torusface', 'torus'],
    ]
    const fqs: string[] = []
    const fds: { centroid: [number, number, number]; normal: [number, number, number]; surface_type: string; area: number }[] = []
    for (let i = 0; i < types.length; i++) {
      const [st] = types[i]
      fqs.push(makeQuery([`@gdf|0,0,${i}|0,0,1`, `@${EX_FEATURE}`], st))
      fds.push({ centroid: [0, 0, i], normal: [0, 0, 1], area: 1, surface_type: st })
    }
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      mesh: { vertices: [], faces: [], face_queries: fqs, face_data: fds },
    }
    const anchors = extractBodyAnchors(body, mintFactory())
    const vals = Object.values(anchors)
    expect(vals).toHaveLength(5)
    const kinds = vals.map((a) => a.kind).sort()
    expect(kinds).toEqual(['cone', 'cylinder', 'plane', 'sphere', 'torus'])
    for (const a of vals) {
      expect(a.geom_hash.startsWith('@gdf|')).toBe(true)
      expect(a.created_by).toBe(EX_FEATURE)
    }
  })

  it('skips faces with unsupported surface type (bspline)', () => {
    const fq = makeQuery([`@gdf|10,10,5|0,0,1`, `@${EX_FEATURE}`], 'face')
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      mesh: {
        vertices: [], faces: [],
        face_queries: [fq],
        face_data: [{ centroid: [10, 10, 5], normal: [0, 0, 1], area: 1, surface_type: 'face' }],
      },
    }
    const anchors = extractBodyAnchors(body, mintFactory())
    expect(Object.keys(anchors)).toHaveLength(0)
  })

  it('emits line and circle edge anchors, skips ellipse and spline', () => {
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
        { kind: 'circle', center: [0, 0, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: 6.283185 },
        { kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: 6.283185 },
        { kind: 'spline', points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]] },
      ],
      edge_queries: [
        makeQuery([`@gde|line|5,0,0|1,0,0|10`, `@${EX_FEATURE}`], 'straightedge'),
        makeQuery([`@gde|circle|0,0,0|0,0,1|5`, `@${EX_FEATURE}`], 'edge'),
        makeQuery([`@gde|ellipse|0,0,0|0,0,1|4`, `@${EX_FEATURE}`], 'edge'),
        makeQuery([`@gde|spline|1,0,0|0,0,0|0`, `@${EX_FEATURE}`], 'edge'),
      ],
    }
    const anchors = extractBodyAnchors(body, mintFactory())
    const vals = Object.values(anchors)
    expect(vals).toHaveLength(2)
    expect(vals[0].kind).toBe('line')
    expect(vals[0].geom_hash.startsWith('@gde|')).toBe(true)
    expect(vals[1].kind).toBe('circle')
    // line anchor point is the midpoint
    expect(vals[0].point[0]).toBeCloseTo(5)
    expect(vals[0].point[1]).toBeCloseTo(0)
    // circle anchor point is the center
    expect(vals[1].point[0]).toBeCloseTo(0)
    expect(vals[1].point[1]).toBeCloseTo(0)
    // line axis is the direction vector
    expect(vals[0].axis[0]).toBeCloseTo(1)
    expect(vals[0].axis[1]).toBeCloseTo(0)
  })

  it('emits vertex anchors for all vertices', () => {
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      vertices: [[0, 0, 0], [10, 0, 0], [10, 10, 0]],
      vertex_queries: [
        makeQuery([`@gdv|0,0,0`, `@${EX_FEATURE}`], 'vertex'),
        makeQuery([`@gdv|10,0,0`, `@${EX_FEATURE}`], 'vertex'),
        makeQuery([`@gdv|10,10,0`, `@${EX_FEATURE}`], 'vertex'),
      ],
    }
    const anchors = extractBodyAnchors(body, mintFactory())
    const vals = Object.values(anchors)
    expect(vals).toHaveLength(3)
    for (const a of vals) {
      expect(a.kind).toBe('point')
      expect(a.geom_hash.startsWith('@gdv|')).toBe(true)
      expect(a.axis).toEqual([0, 0, 1])
      expect(a.created_by).toBe(EX_FEATURE)
    }
    // point anchors carry the vertex position
    expect(vals[0].point).toEqual([0, 0, 0])
    expect(vals[1].point).toEqual([10, 0, 0])
    expect(vals[2].point).toEqual([10, 10, 0])
  })

  it('returns empty anchors for a body with no queries', () => {
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      mesh: { vertices: [], faces: [] },
    }
    const anchors = extractBodyAnchors(body, mintFactory())
    expect(Object.keys(anchors)).toHaveLength(0)
  })

  it('produces unique anchor ids across body types', () => {
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      mesh: {
        vertices: [], faces: [],
        face_queries: [
          makeQuery([`@gdf|0,0,0|0,0,1`, `@${EX_FEATURE}`], 'flatface'),
          makeQuery([`@gdf|1,0,0|1,0,0`, `@${EX_FEATURE}`], 'flatface'),
        ],
        face_data: [
          { centroid: [0, 0, 0], normal: [0, 0, 1], area: 1, surface_type: 'flatface' },
          { centroid: [1, 0, 0], normal: [1, 0, 0], area: 1, surface_type: 'flatface' },
        ],
      },
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
      ],
      edge_queries: [makeQuery([`@gde|line|5,0,0|1,0,0|10`, `@${EX_FEATURE}`], 'straightedge')],
      vertices: [[0, 0, 0]],
      vertex_queries: [makeQuery([`@gdv|0,0,0`, `@${EX_FEATURE}`], 'vertex')],
    }
    const anchors = extractBodyAnchors(body, mintFactory())
    const keys = Object.keys(anchors)
    expect(keys).toHaveLength(4)  // 2 faces + 1 edge + 1 vertex
    expect(new Set(keys).size).toBe(keys.length)
  })
})
