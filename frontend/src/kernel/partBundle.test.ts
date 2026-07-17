import { describe, it, expect } from 'vitest'
import { toEdgeCurve, toBodyMesh, toPartBundle, extractBodyAnchors } from './partBundle'
import type { EdgeData, BodyResult, FaceData } from '../types/cad'

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

  it('mints anchor ids from a wide random prefix, so two builds of the same doc never collide', () => {
    // Math.random().toString(36).slice(2, 6) (the old minter) can collapse to
    // a single character -- (0.5).toString(36) === '0.i' -- making it
    // plausible for two builds of the same doc to draw the same prefix.
    // migrateBundle then writes `anchors[remap.get(newId) ?? newId]`, so a
    // fresh id from one build colliding with a migrated-to id from another
    // silently drops an anchor. randomId(8) draws from a 2^64 keyspace, which
    // makes that collision practically impossible.
    const bodies: Record<string, BodyResult> = {
      b1: {
        id: 'b1', created_by: 'ex1', modified_by: [],
        mesh: {
          vertices: [], faces: [],
          face_queries: [makeQuery([`@gdf|0,0,0|0,0,1`, `@${EX_FEATURE}`], 'flatface')],
          face_data: [{ centroid: [0, 0, 0], normal: [0, 0, 1], area: 1, surface_type: 'flatface' }],
        },
      },
    }
    const bundleA = toPartBundle('doc1', 1, bodies)
    const bundleB = toPartBundle('doc1', 2, bodies)
    const idsA = Object.keys(bundleA.anchors)
    const idsB = Object.keys(bundleB.anchors)
    expect(idsA).toHaveLength(1)
    expect(idsB).toHaveLength(1)
    expect(idsA.some(id => idsB.includes(id))).toBe(false)
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
    // Curved kinds carry a surface_frame (Stage A); flatface has none because
    // the normal already IS its axis.
    const types: [string, string, [number, number, number] | null][] = [
      ['flatface', 'plane', null],
      ['cylinderface', 'cylinder', [1, 0, 0]],
      ['coneface', 'cone', [1, 0, 0]],
      ['sphereface', 'sphere', [0, 0, 1]],
      ['torusface', 'torus', [1, 0, 0]],
    ]
    const fqs: string[] = []
    const fds: FaceData[] = []
    for (let i = 0; i < types.length; i++) {
      const [st, , axis] = types[i]
      fqs.push(makeQuery([`@gdf|0,0,${i}|0,0,1`, `@${EX_FEATURE}`], st))
      fds.push({
        centroid: [0, 0, i], normal: [0, 0, 1], area: 1, surface_type: st,
        surface_frame: axis ? { axis, origin: [5, 5, i] } : undefined,
      })
    }
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      mesh: { vertices: [], faces: [], face_queries: fqs, face_data: fds },
    }
    const { anchors } = extractBodyAnchors(body, mintFactory())
    const vals = Object.values(anchors)
    expect(vals).toHaveLength(5)
    const kinds = vals.map((a) => a.kind).sort()
    expect(kinds).toEqual(['cone', 'cylinder', 'plane', 'sphere', 'torus'])
    for (const a of vals) {
      expect(a.geom_hash.startsWith('@gdf|')).toBe(true)
      expect(a.created_by).toBe(EX_FEATURE)
    }
    // The plane anchor keeps the centroid/normal; the curved anchors take
    // their point/axis from surface_frame, not from centroid/normal.
    const plane = vals.find((a) => a.kind === 'plane')!
    expect(plane.point).toEqual([0, 0, 0])
    expect(plane.axis).toEqual([0, 0, 1])
    const cylinder = vals.find((a) => a.kind === 'cylinder')!
    expect(cylinder.point).toEqual([5, 5, 1])
    expect(cylinder.axis).toEqual([1, 0, 0])
    const sphere = vals.find((a) => a.kind === 'sphere')!
    expect(sphere.point).toEqual([5, 5, 3])
    expect(sphere.axis).toEqual([0, 0, 1])
  })

  it('emits no anchor for a curved face with no surface_frame (fail-safe, not fail-wrong)', () => {
    const fq = makeQuery([`@gdf|0,0,0|0,0,1`, `@${EX_FEATURE}`], 'cylinderface')
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      mesh: {
        vertices: [], faces: [],
        face_queries: [fq],
        face_data: [{ centroid: [0, 0, 0], normal: [0, 0, 1], area: 1, surface_type: 'cylinderface' }],
      },
    }
    const { anchors } = extractBodyAnchors(body, mintFactory())
    expect(Object.keys(anchors)).toHaveLength(0)
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
    const { anchors } = extractBodyAnchors(body, mintFactory())
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
    const { anchors } = extractBodyAnchors(body, mintFactory())
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
    const { anchors } = extractBodyAnchors(body, mintFactory())
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
    const { anchors } = extractBodyAnchors(body, mintFactory())
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
    const { anchors } = extractBodyAnchors(body, mintFactory())
    const keys = Object.keys(anchors)
    expect(keys).toHaveLength(4)  // 2 faces + 1 edge + 1 vertex
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('prefers @u| construction UUID over @gdf| geometry descriptor for geom_hash', () => {
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      mesh: {
        vertices: [], faces: [],
        face_queries: [
          // @u| token present alongside @gdf| — prefers @u|
          makeQuery(['@u|aaa1112223334445', '@gdf|0,0,0|0,0,1', `@${EX_FEATURE}`], 'flatface'),
        ],
        face_data: [{ centroid: [0, 0, 0], normal: [0, 0, 1], area: 1, surface_type: 'flatface' }],
      },
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
      ],
      edge_queries: [makeQuery(['@u|bbb1112223334445', `@${EX_FEATURE}`], 'straightedge')],
      vertices: [[0, 0, 0]],
      vertex_queries: [makeQuery(['@u|ccc1112223334445', `@${EX_FEATURE}`], 'vertex')],
    }
    const { anchors } = extractBodyAnchors(body, mintFactory())
    expect(Object.keys(anchors)).toHaveLength(3)
    const faceAnchors = Object.values(anchors).filter((a) => a.kind === 'plane')
    expect(faceAnchors[0].geom_hash).toBe('@u|aaa1112223334445')
    const edgeAnchors = Object.values(anchors).filter((a) => a.kind === 'line')
    expect(edgeAnchors[0].geom_hash).toBe('@u|bbb1112223334445')
    const vertexAnchors = Object.values(anchors).filter((a) => a.kind === 'point')
    expect(vertexAnchors[0].geom_hash).toBe('@u|ccc1112223334445')
  })

  it('falls back to @gdf| when @u| is absent (backward compat with pre-Stage-7 bundles)', () => {
    const body: BodyResult = {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      mesh: {
        vertices: [], faces: [],
        face_queries: [makeQuery(['@gdf|0,0,0|0,0,1', `@${EX_FEATURE}`], 'flatface')],
        face_data: [{ centroid: [0, 0, 0], normal: [0, 0, 1], area: 1, surface_type: 'flatface' }],
      },
    }
    const { anchors } = extractBodyAnchors(body, mintFactory())
    expect(Object.keys(anchors)).toHaveLength(1)
    const a = Object.values(anchors)[0]
    expect(a.geom_hash.startsWith('@gdf|')).toBe(true)
  })
})

// ── Stage 7: the entity -> anchor join a pick resolves through ──────────────

describe('extractBodyAnchors entity index', () => {
  function mintFactory(): () => string {
    let n = 0
    return () => { n++; return `a${n}` }
  }

  /** One flat face, one freeform face, one line edge, one ellipse edge, one vertex. */
  function mixedBody(): BodyResult {
    return {
      id: 'b1', created_by: EX_FEATURE, modified_by: [],
      mesh: {
        vertices: [], faces: [],
        face_queries: [
          makeQuery(['@gdf|0,0,0|0,0,1', `@${EX_FEATURE}`], 'flatface'),
          makeQuery(['@gdf|1,1,1|0,0,1', `@${EX_FEATURE}`], 'face'),
        ],
        face_data: [
          { centroid: [0, 0, 0], normal: [0, 0, 1], area: 1, surface_type: 'flatface' },
          { centroid: [1, 1, 1], normal: [0, 0, 1], area: 1, surface_type: 'face' },
        ],
      },
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
        { kind: 'ellipse', center: [0, 0, 0], a: 5, b: 3, axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: 1 },
      ],
      edge_queries: [
        makeQuery(['@gde|5,0,0|1,0,0', `@${EX_FEATURE}`], 'edge'),
        makeQuery(['@gde|0,0,0|0,0,1', `@${EX_FEATURE}`], 'edge'),
      ],
      vertices: [[0, 0, 0]],
      vertex_queries: [makeQuery(['@gdv|0,0,0', `@${EX_FEATURE}`], 'vertex')],
    }
  }

  it('names every anchor it minted, under the entity that owns it', () => {
    const { anchors, entityAnchors } = extractBodyAnchors(mixedBody(), mintFactory())
    const named = [
      ...entityAnchors.faces.flat(), ...entityAnchors.edges.flat(), ...entityAnchors.vertices.flat(),
    ]
    expect(named.sort()).toEqual(Object.keys(anchors).sort())
  })

  it('keeps a slot for every entity, so the positional join to the mesh holds', () => {
    const { entityAnchors } = extractBodyAnchors(mixedBody(), mintFactory())
    expect(entityAnchors.faces).toHaveLength(2)
    expect(entityAnchors.edges).toHaveLength(2)
    expect(entityAnchors.vertices).toHaveLength(1)
  })

  it('leaves the unmatable entities empty rather than shifting their neighbours', () => {
    const { entityAnchors } = extractBodyAnchors(mixedBody(), mintFactory())
    expect(entityAnchors.faces[0]).toHaveLength(1)   // flatface
    expect(entityAnchors.faces[1]).toEqual([])       // freeform
    expect(entityAnchors.edges[0]).toHaveLength(1)   // line
    expect(entityAnchors.edges[1]).toEqual([])       // ellipse
  })

  it('resolves each entity to the anchor whose geometry it carries', () => {
    const { anchors, entityAnchors } = extractBodyAnchors(mixedBody(), mintFactory())
    expect(anchors[entityAnchors.faces[0][0]].kind).toBe('plane')
    expect(anchors[entityAnchors.edges[0][0]].kind).toBe('line')
    expect(anchors[entityAnchors.vertices[0][0]].kind).toBe('point')
  })

  it('toPartBundle carries the index onto each BodyMesh', () => {
    const bundle = toPartBundle('doc1', 3, { b1: mixedBody() })
    expect(bundle.bodies[0].entityAnchors!.faces[0][0]).toBeDefined()
    expect(bundle.anchors[bundle.bodies[0].entityAnchors!.faces[0][0]]).toBeDefined()
  })
})
