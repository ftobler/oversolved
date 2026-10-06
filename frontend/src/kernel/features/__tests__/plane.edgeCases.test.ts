import { describe, it, expect } from 'vitest'
import { Repository } from '../../query'
import { solvePlane } from '../plane'
import type { Body } from '../../types3d'

// Covers the degenerate / sketch-lifted branches of the pure plane solver that
// the happy-path suite (plane.test.ts) does not reach: getEdge3d's
// external_params lift (and its no-coordinates throw), and the arbitrary-axis
// fallbacks when an edge is parallel to a face normal or a point lies on its
// edge.

type Dict = Record<string, unknown>

function run(repo: Repository, feature: Dict, bodyStore: Record<string, Body> = {}) {
  return solvePlane(null, null, null, feature, repo, bodyStore)
}

function close(a: number[], b: number[]) {
  expect(a.length).toBe(b.length)
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9))
}

describe('solvePlane getEdge3d via line_angle', () => {
  it('lifts a 2D sketch line through its plane transform (_pt_<sketch>)', () => {
    const repo = new Repository()
    // A sketch-local line: external_params are 2D [x1,y1,x2,y2] in the sketch
    // frame, lifted to 3D through the registered plane transform.
    repo.register('ln', { kind: 'line', external_params: [0, 0, 2, 0], sketch_id: 'sk' })
    repo.elements.set('_pt_sk', { origin: [10, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0] })

    const res = run(repo, { id: 'pl', kind: 'plane', definition: { mode: 'line_angle', line: '@ln', angle: 0 } })

    // start lifts to (10,0,0), end to (12,0,0) -> x-axis +x, origin at the lifted start.
    close(res.plane.origin, [10, 0, 0])
    close(res.plane.x_axis, [1, 0, 0])
  })

  it('falls back to z=0 when the sketch line has no resolvable plane transform', () => {
    const repo = new Repository()
    repo.register('ln', { kind: 'line', external_params: [0, 0, 4, 0] })  // no sketch_id

    const res = run(repo, { id: 'pl', kind: 'plane', definition: { mode: 'line_angle', line: '@ln', angle: 0 } })

    close(res.plane.origin, [0, 0, 0])
    close(res.plane.x_axis, [1, 0, 0])
  })

  it('throws when the edge reference carries no line coordinates', () => {
    const repo = new Repository()
    repo.register('ln', { kind: 'line' })  // neither external_params nor start/end
    expect(() => run(repo, { id: 'pl', kind: 'plane', definition: { mode: 'line_angle', line: '@ln', angle: 0 } }))
      .toThrow(/no line coordinates/)
  })
})

describe('solvePlane arbitrary-axis fallbacks', () => {
  it('on_face_edge_angle picks an arbitrary x when the edge is parallel to the face normal', () => {
    const repo = new Repository()
    repo.register('f1', { centroid: [0, 0, 0], normal: [0, 0, 1], type: 'face' })
    repo.register('e1', { start: [0, 0, 0], end: [0, 0, 1], type: 'edge' })  // parallel to normal

    const res = run(repo, { id: 'pl', kind: 'plane', definition: { mode: 'on_face_edge_angle', face: '@f1', edge: '@e1', angle: 0 } })

    close(res.plane.normal, [0, 0, 1])
    // x falls back to cross(normal, [1,0,0]) = [0,1,0]; frame stays orthonormal.
    close(res.plane.x_axis, [0, 1, 0])
    close(res.plane.y_axis, [-1, 0, 0])
  })

  it('edge_point picks an arbitrary y when the point lies on the edge', () => {
    const repo = new Repository()
    repo.register('e1', { start: [0, 0, 0], end: [2, 0, 0] })
    repo.register('pt', { origin: [1, 0, 0] })  // on the edge -> projection == point

    const res = run(repo, { id: 'pl', kind: 'plane', definition: { mode: 'edge_point', edge: '@e1', point: '@pt' } })

    close(res.plane.origin, [1, 0, 0])
    close(res.plane.x_axis, [1, 0, 0])
    // y falls back to cross(x, [0,0,1]) = [0,-1,0]; orthonormal frame.
    close(res.plane.y_axis, [0, -1, 0])
    expect(res.plane.x_axis[0] * res.plane.y_axis[0]
      + res.plane.x_axis[1] * res.plane.y_axis[1]
      + res.plane.x_axis[2] * res.plane.y_axis[2]).toBeCloseTo(0, 9)
  })

  it('line_angle stays orthonormal for a line along the z axis', () => {
    // The reference direction flips to +x once the line is near the z axis;
    // otherwise the projection onto [0,0,1] would be degenerate.
    const repo = new Repository()
    repo.register('ln', { start: [0, 0, 0], end: [0, 0, 5] })

    const res = run(repo, { id: 'pl', kind: 'plane', definition: { mode: 'line_angle', line: '@ln', angle: 0 } })

    close(res.plane.x_axis, [0, 0, 1])
    close(res.plane.y_axis, [1, 0, 0])
    close(res.plane.normal, [0, 1, 0])
  })

  it('edge_point stays orthonormal for a z-axis edge with the point on it', () => {
    // Both degeneracies at once: the point projects onto itself, and the line
    // is near the z axis so the reference flips to +x.
    const repo = new Repository()
    repo.register('e1', { start: [0, 0, 0], end: [0, 0, 2] })
    repo.register('pt', { origin: [0, 0, 1] })  // on the edge -> projection == point

    const res = run(repo, { id: 'pl', kind: 'plane', definition: { mode: 'edge_point', edge: '@e1', point: '@pt' } })

    close(res.plane.origin, [0, 0, 1])
    close(res.plane.x_axis, [0, 0, 1])
    close(res.plane.y_axis, [0, 1, 0])
    close(res.plane.normal, [-1, 0, 0])
  })
})

describe('solvePlane guard paths', () => {
  it('on_face refuses a slash face ref when no OCC context is available', () => {
    // The topo-fallback form `@<body>/face/<idx>` needs the body's shape; with
    // no oc/table the resolver must name the ref instead of dereferencing null.
    const repo = new Repository()
    expect(() =>
      run(repo, { id: 'pl', kind: 'plane', definition: { mode: 'on_face', face: '@body_a/face/0' } }),
    ).toThrow(/face not found: "@body_a\/face\/0"/)
  })

  it('three_point refuses coincident points instead of normalizing a zero vector', () => {
    const repo = new Repository()
    repo.register('p1', { origin: [1, 1, 1] })
    repo.register('p2', { origin: [1, 1, 1] })
    repo.register('p3', { origin: [0, 3, 0] })
    expect(() => run(repo, {
      id: 'pl', kind: 'plane',
      definition: { mode: 'three_point', p1: '@p1', p2: '@p2', p3: '@p3' },
    })).toThrow(/zero-length vector/)
  })

  it('three_point names a point that does not resolve', () => {
    const repo = new Repository()
    repo.register('p1', { origin: [0, 0, 0] })
    repo.register('p3', { origin: [0, 3, 0] })
    expect(() => run(repo, {
      id: 'pl', kind: 'plane',
      definition: { mode: 'three_point', p1: '@p1', p2: '@missing', p3: '@p3' },
    })).toThrow(/point not found: "@missing"/)
  })

  it('plane_point names a missing reference plane', () => {
    const repo = new Repository()
    repo.register('pt', { origin: [1, 2, 3] })
    expect(() => run(repo, {
      id: 'pl', kind: 'plane',
      definition: { mode: 'plane_point', plane: '@missing', point: '@pt' },
    })).toThrow(/plane not found: "@missing"/)
  })

  it('line_angle names a missing line', () => {
    const repo = new Repository()
    expect(() => run(repo, {
      id: 'pl', kind: 'plane',
      definition: { mode: 'line_angle', line: '@missing', angle: 0 },
    })).toThrow(/line not found: "@missing"/)
  })

  it('on_face names a face ref the repo cannot resolve', () => {
    const repo = new Repository()
    expect(() => run(repo, {
      id: 'pl', kind: 'plane',
      definition: { mode: 'on_face', face: '@missing' },
    })).toThrow(/face not found: "@missing"/)
  })
})
