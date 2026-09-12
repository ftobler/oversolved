import { describe, it, expect } from 'vitest'
import { toEdgeCurve, toBodyMesh, toPartBundle, extractBodyAnchors, anchorIdFor, anchorKindHasAxis, anchorByDescriptor, ANCHOR_TIE_EPSILON_SQ, BUNDLE_SCHEMA, BUNDLE_BUILD_ID, BUNDLE_BUILD_FINGERPRINT, buildBundleFingerprint } from './partBundle'
import type { Anchor, AnchorKind } from './partBundle'
import type { EdgeData, BodyResult, FaceData, MateAnchorDescriptor } from '../types/cad'

describe('BUNDLE_BUILD_FINGERPRINT drift guard', () => {
  it('is derived from BUNDLE_SCHEMA and BUNDLE_BUILD_ID, so bumping either changes it', () => {
    // The constant must always be computed from the current inputs, never
    // hand-set, or a developer could pin it to a stale value and defeat the
    // cache-miss invalidation the fingerprint exists to provide.
    expect(BUNDLE_BUILD_FINGERPRINT).toBe(buildBundleFingerprint(BUNDLE_SCHEMA, BUNDLE_BUILD_ID))
    // Bumping either the schema or the geometry build id changes the
    // fingerprint, so a deploy that forgot one of the two still misses.
    expect(buildBundleFingerprint(BUNDLE_SCHEMA + 1, BUNDLE_BUILD_ID)).not.toBe(BUNDLE_BUILD_FINGERPRINT)
    expect(buildBundleFingerprint(BUNDLE_SCHEMA, BUNDLE_BUILD_ID + 1)).not.toBe(BUNDLE_BUILD_FINGERPRINT)
  })
})

describe('anchorKindHasAxis', () => {
  // Every face/edge kind's axis is real geometry (a surface frame axis, a
  // plane normal, an edge direction, a circle normal). A sphere's and a vertex's
  // axis are the `[0, 0, 1]` placeholder, and an axis-reading mate on one would
  // weld about a direction the anchor does not have. The expected map is spelled
  // out so a kind silently added to (or dropped from) the predicate fails here.
  const EXPECTED: Record<AnchorKind, boolean> = {
    plane: true,
    cylinder: true,
    cone: true,
    sphere: false,
    torus: true,
    line: true,
    circle: true,
    point: false,
  }
  const allKinds = Object.keys(EXPECTED) as AnchorKind[]

  it('matches the explicit axis map for all eight kinds', () => {
    for (const kind of allKinds) {
      expect(anchorKindHasAxis(kind)).toBe(EXPECTED[kind])
    }
  })

  it('is false for the two placeholder-axis kinds', () => {
    expect(anchorKindHasAxis('sphere')).toBe(false)
    expect(anchorKindHasAxis('point')).toBe(false)
  })
})

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

  // The consumer half of the entity<->query array contract. A BodyResult can
  // still arrive with more edges than queries (a bundle cached before
  // solidToEdges padded, or one from outside this kernel); the positional zip
  // must not put `undefined` into `EdgeCurve.id`, which is typed `string`.
  // Nothing throws on that -- it just yields a bundle of edges whose id nothing
  // matches, which is why it went unnoticed.
  it('never leaves EdgeCurve.id undefined when edge_queries is short', () => {
    const body: BodyResult = {
      id: 'body_short',
      created_by: '',
      modified_by: [],
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
        { kind: 'line', start: [10, 0, 0], end: [10, 5, 0] },
      ],
      edge_queries: [],
    }
    const result = toBodyMesh(body)
    expect(result.edges).toHaveLength(2)
    for (const e of result.edges) {
      expect(e.id).toBeDefined()
      expect(typeof e.id).toBe('string')
    }
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

  it('always copies a typed-array mesh to fresh arrays owned by the bundle', () => {
    // A typed mesh handed straight in (a future producer) must not be reused:
    // the bundle feeds bundleTransferables, and transferring an engine-owned
    // buffer would detach the producer's cache. The bundle flattens to its own
    // copy and the input stays intact.
    const engineVerts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const engineFaces = new Uint32Array([0, 1, 2])
    const body: BodyResult = {
      id: 'body_typed',
      created_by: 'ex1',
      modified_by: [],
      mesh: { vertices: engineVerts, faces: engineFaces, triangle_to_face: [0] },
    }
    const result = toBodyMesh(body)
    // Buffer identity differs: the bundle owns its arrays.
    expect(result.mesh.vertices.buffer).not.toBe(engineVerts.buffer)
    expect(result.mesh.indices.buffer).not.toBe(engineFaces.buffer)
    expect(Array.from(result.mesh.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(result.mesh.indices)).toEqual([0, 1, 2])
    // The engine's input is untouched and not detached.
    expect(engineVerts.buffer.byteLength).toBeGreaterThan(0)
    expect(engineFaces.buffer.byteLength).toBeGreaterThan(0)
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
    const bundle = toPartBundle('doc123', 'h5', bodies)
    expect(bundle.doc_id).toBe('doc123')
    expect(bundle.content_hash).toBe('h5')
    expect(bundle.bodies).toHaveLength(2)
    expect(bundle.bodies[1].edges).toHaveLength(1)
    // Anchors populated (empty for these no-query mock bodies)
    expect(typeof bundle.anchors).toBe('object')
    expect(Object.keys(bundle.anchors).length).toBeGreaterThanOrEqual(0)
  })

  it('mints the same deterministic anchor id for two builds of the same geometry (no cache needed)', () => {
    // Anchor ids are deterministic from the stable geom_hash + kind, so a
    // persisted mate ref survives any rebuild with no cache at all. The old
    // minter drew a random prefix per build, which made two cold builds of one
    // rev mint DIFFERENT ids and strand every persisted mate ref on a cache
    // wipe.
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
    const bundleA = toPartBundle('doc1', 'h1', bodies)
    const bundleB = toPartBundle('doc1', 'h2', bodies)
    const idsA = Object.keys(bundleA.anchors)
    const idsB = Object.keys(bundleB.anchors)
    expect(idsA).toHaveLength(1)
    expect(idsB).toHaveLength(1)
    // Same geom_hash + kind -> same id, across builds and doc revs.
    expect(idsA).toEqual(idsB)
  })

  it('anchorIdFor is a deterministic hash of geom_hash + kind', () => {
    expect(anchorIdFor('@u|aaa', 'plane')).toBe(anchorIdFor('@u|aaa', 'plane'))
    expect(anchorIdFor('@u|aaa', 'plane')).not.toBe(anchorIdFor('@u|aaa', 'line'))
    expect(anchorIdFor('@u|aaa', 'plane')).not.toBe(anchorIdFor('@u|bbb', 'plane'))
    expect(anchorIdFor('@u|aaa', 'plane')).toMatch(/^a_[0-9a-f]{16}$/)
  })

  it('two elements hashing to one id get distinct ids (tier-1 collision rule)', () => {
    // Same geom_hash + kind in one bundle (e.g. two coincident vertices whose
    // positional @gdv descriptor is identical): the first keeps the bare id,
    // the second gets a disambiguation suffix. Never two elements on one id.
    const bodies: Record<string, BodyResult> = {
      b1: {
        id: 'b1', created_by: 'ex1', modified_by: [],
        mesh: {
          vertices: [], faces: [],
          face_queries: [
            makeQuery([`@gdf|0,0,0|0,0,1`, `@${EX_FEATURE}`], 'flatface'),
            makeQuery([`@gdf|0,0,0|0,0,1`, `@${EX_FEATURE}`], 'flatface'),
          ],
          face_data: [
            { centroid: [0, 0, 0], normal: [0, 0, 1], area: 1, surface_type: 'flatface' },
            { centroid: [0, 0, 0], normal: [0, 0, 1], area: 1, surface_type: 'flatface' },
          ],
        },
      },
    }
    const bundle = toPartBundle('doc1', 'h1', bodies)
    const ids = Object.keys(bundle.anchors)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    const base = anchorIdFor('@gdf|0,0,0|0,0,1', 'plane')
    expect(ids.sort()).toEqual([base, `${base}_2`].sort())
  })
})

// ─── Anchor extraction (Stage 2c) ───

/** Build a query string in the ancestry format that `findDescriptorInQuery` can parse. */
function makeQuery(ids: string[], typeRestriction: string | null): string {
  const hexLengths = ids.map((id) => id.length.toString(16)).join(',')
  const body = ids.join('')
  return typeRestriction ? `?${hexLengths};${body}:${typeRestriction}` : `?${hexLengths};${body}`
}

const EX_FEATURE = 'ex123'

describe('extractBodyAnchors', () => {
  function mintFactory(): (geomHash: string, kind: AnchorKind) => string {
    let n = 0
    return () => { n++; return `a${n}` }
  }

  // entityAnchors is indexed by ENTITY index -- assemblyPick even reads
  // `entityAnchors.faces.length` as the body's face count. The loops must
  // therefore be bounded by face_data / edges / vertices, never by the parallel
  // query array, which is the one that can come up short.
  it('gives every entity a slot even when the query arrays are short or absent', () => {
    const body: BodyResult = {
      id: 'body_short_anchors',
      created_by: '',
      modified_by: [],
      mesh: {
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces: [[0, 1, 2]],
        face_data: [
          { centroid: [0, 0, 0], normal: [0, 0, 1], area: 1, surface_type: 'flatface' },
          { centroid: [0, 0, 1], normal: [0, 0, 1], area: 1, surface_type: 'flatface' },
        ],
        face_queries: [],  // N faces, 0 queries
      },
      edges: [
        { kind: 'line', start: [0, 0, 0], end: [10, 0, 0] },
        { kind: 'line', start: [10, 0, 0], end: [10, 5, 0] },
      ],
      // edge_queries / vertex_queries absent entirely
      vertices: [[0, 0, 0], [10, 0, 0], [10, 5, 0]],
    }
    const { entityAnchors } = extractBodyAnchors(body, mintFactory())
    expect(entityAnchors.faces).toHaveLength(2)
    expect(entityAnchors.edges).toHaveLength(2)
    expect(entityAnchors.vertices).toHaveLength(3)
    expect(entityAnchors.faces.flat()).toEqual([])
    expect(entityAnchors.edges.flat()).toEqual([])
    expect(entityAnchors.vertices.flat()).toEqual([])
  })

  it('skips entities instead of throwing when the query array runs short', () => {
    // solidToEdges/solidToVertices return every edge and vertex but an EMPTY
    // query array when the body carries no `created_by`, so the positional zip
    // runs off the end. That used to throw out of findDescriptorInQuery and,
    // since toPartBundle's body loop has no per-body catch, cost EVERY body its
    // anchors -- not just this one.
    const body: BodyResult = {
      id: 'b1', created_by: '', modified_by: [],
      mesh: { vertices: [], faces: [], face_queries: [], face_data: [] },
      edges: [{ kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }],
      edge_queries: [],
      vertices: [[0, 0, 0], [1, 0, 0]],
      vertex_queries: [],
    } as unknown as BodyResult

    const { anchors, entityAnchors } = extractBodyAnchors(body, mintFactory())

    expect(anchors).toEqual({})
    // Each entity still keeps its positional slot, empty, so the join to
    // `edges` / `vertices` by index stays intact.
    expect(entityAnchors.edges).toEqual([[]])
    expect(entityAnchors.vertices).toEqual([[], []])
  })

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
          // @u| token present alongside @gdf|, prefers @u|
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

// ─── Stage 7: the entity -> anchor join a pick resolves through ───

describe('extractBodyAnchors entity index', () => {
  function mintFactory(): (geomHash: string, kind: AnchorKind) => string {
    let n = 0
    return () => { n++; return `a${n}` }
  }

  // One flat face, one freeform face, one line edge, one ellipse edge, one vertex.
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
    const bundle = toPartBundle('doc1', 'h3', { b1: mixedBody() })
    expect(bundle.bodies[0].entityAnchors!.faces[0][0]).toBeDefined()
    expect(bundle.anchors[bundle.bodies[0].entityAnchors!.faces[0][0]]).toBeDefined()
  })
})

describe('anchorByDescriptor', () => {
  const anchor = (
    kind: AnchorKind, geom_hash: string, created_by: string, point: [number, number, number],
  ): Anchor => ({ kind, point, axis: [0, 0, 1], geom_hash, created_by })

  const descriptor = (over: Partial<MateAnchorDescriptor>): MateAnchorDescriptor => ({
    geom_hash: '@gdf|old', kind: 'plane', created_by: 'feat1', point: [0, 0, 0],
    ...over,
  })

  // The exported constant is the shared tie guard; pin its value so a change
  // that silently loosens the fail-safe tie rule fails here.
  it('exposes the shared tie epsilon the build-time remap also uses', () => {
    expect(ANCHOR_TIE_EPSILON_SQ).toBe(1e-10)
  })

  it('tier 1: returns the anchor matching geom_hash and kind', () => {
    const anchors = { idA: anchor('plane', '@gdf|a', 'feat1', [0, 0, 0]) }
    expect(anchorByDescriptor(anchors, descriptor({ geom_hash: '@gdf|a' }))).toBe(anchors.idA)
  })

  it('tier 2: a moved positional geom_hash re-finds the element by created_by + kind', () => {
    const anchors = {
      moved: anchor('plane', '@gdf|moved', 'feat1', [5, 0, 0]),
      sibling: anchor('line', '@gde|sibling', 'feat1', [5, 0, 0]),
    }
    expect(anchorByDescriptor(anchors, descriptor({ point: [0, 0, 0] }))).toBe(anchors.moved)
  })

  it('tier 2 nearest: picks the closer of two same-kind candidates', () => {
    const anchors = {
      near: anchor('plane', '@gdf|near', 'feat1', [1, 0, 0]),
      far: anchor('plane', '@gdf|far', 'feat1', [10, 0, 0]),
    }
    expect(anchorByDescriptor(anchors, descriptor({ point: [0, 0, 0] }))).toBe(anchors.near)
  })

  it('tie: two equidistant candidates refuse (fail-safe)', () => {
    const anchors = {
      plus: anchor('plane', '@gdf|plus', 'feat1', [1, 0, 0]),
      minus: anchor('plane', '@gdf|minus', 'feat1', [-1, 0, 0]),
    }
    expect(anchorByDescriptor(anchors, descriptor({ point: [0, 0, 0] }))).toBeUndefined()
  })

  it('tie: a separation below the epsilon also refuses', () => {
    const eps = Math.sqrt(ANCHOR_TIE_EPSILON_SQ) / 4
    const anchors = {
      plus: anchor('plane', '@gdf|plus', 'feat1', [eps, 0, 0]),
      minus: anchor('plane', '@gdf|minus', 'feat1', [-eps, 0, 0]),
    }
    expect(anchorByDescriptor(anchors, descriptor({ point: [0, 0, 0] }))).toBeUndefined()
  })

  it('a gone @u| identity refuses rather than rebinding to a same-kind neighbour', () => {
    const anchors = { pos: anchor('plane', '@gdf|0,0,0', 'feat1', [0, 0, 0]) }
    expect(anchorByDescriptor(anchors, descriptor({ geom_hash: '@u|gone-uuid' }))).toBeUndefined()
  })

  it('a changed created_by finds no tier-2 candidate', () => {
    const anchors = { other: anchor('plane', '@gdf|other', 'other-feature', [0, 0, 0]) }
    expect(anchorByDescriptor(anchors, descriptor({}))).toBeUndefined()
  })

  it('kind isolation: a same-created_by candidate of another kind is not a match', () => {
    const anchors = { line: anchor('line', '@gde|line', 'feat1', [0, 0, 0]) }
    expect(anchorByDescriptor(anchors, descriptor({ geom_hash: '@gdf|plane' }))).toBeUndefined()
  })

  it('a tier-1 tie falls through to the tier-2 created_by + kind match', () => {
    // Two anchors share the descriptor's geom_hash + kind but belong to another
    // body, so the tier-1 exact set ties. That must not dead-end: tier 2 scopes
    // back to the descriptor's own body and finds its unique candidate.
    const anchors = {
      otherA: anchor('plane', '@gdf|tie', 'other', [1, 0, 0]),
      otherB: anchor('plane', '@gdf|tie', 'other', [-1, 0, 0]),
      mine: anchor('plane', '@gdf|mine', 'feat1', [5, 0, 0]),
    }
    expect(anchorByDescriptor(anchors, descriptor({ geom_hash: '@gdf|tie' }))).toBe(anchors.mine)
  })
})
