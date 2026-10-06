import { describe, it, expect } from 'vitest'
import { initGlobalRepo, Repository } from '../../query'
import { solvePlane } from '../plane'
import type { Body } from '../../types3d'

type Dict = Record<string, unknown>

function run(repo: Repository, feature: Dict, bodyStore: Record<string, Body> = {}) {
  return solvePlane(null, null, null, feature, repo, bodyStore)
}

function close(a: number[], b: number[]) {
  expect(a.length).toBe(b.length)
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9))
}

describe('solvePlane', () => {
  it('offset translates the reference plane origin along its normal', () => {
    const repo = initGlobalRepo()
    const res = run(repo, {
      id: 'pl1',
      kind: 'plane',
      definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 5 },
    })
    expect(res.status).toBe('ok')
    close(res.plane.origin, [0, 0, 5])
    close(res.plane.x_axis, [1, 0, 0])
    close(res.plane.y_axis, [0, 1, 0])
    close(res.plane.normal, [0, 0, 1])
  })

  it('offset accepts `distance` as an alias and `reference` for the plane', () => {
    const repo = initGlobalRepo()
    const res = run(repo, {
      id: 'pl1',
      kind: 'plane',
      definition: { mode: 'offset', reference: '@builtin_plane_top', distance: -3 },
    })
    close(res.plane.origin, [0, -3, 0])
    close(res.plane.normal, [0, 1, 0])
  })

  it('registers the solved frame under the feature id with type plane', () => {
    const repo = initGlobalRepo()
    run(repo, {
      id: 'plA',
      kind: 'plane',
      definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 2 },
    })
    const reg = repo.elements.get('plA') as Dict
    expect(reg).toBeTruthy()
    expect(reg.type).toBe('plane')
    close(reg.origin as number[], [0, 0, 2])
  })

  it('three_point builds a frame from three points', () => {
    const repo = new Repository()
    repo.register('p1', { origin: [0, 0, 0] })
    repo.register('p2', { origin: [2, 0, 0] })
    repo.register('p3', { origin: [0, 3, 0] })
    const res = run(repo, {
      id: 'pl1',
      kind: 'plane',
      definition: { mode: 'three_point', p1: '@p1', p2: '@p2', p3: '@p3' },
    })
    close(res.plane.origin, [0, 0, 0])
    close(res.plane.x_axis, [1, 0, 0])
    close(res.plane.y_axis, [0, 1, 0])
    close(res.plane.normal, [0, 0, 1])
  })

  it('three_point throws on collinear points', () => {
    const repo = new Repository()
    repo.register('p1', { origin: [0, 0, 0] })
    repo.register('p2', { origin: [1, 0, 0] })
    repo.register('p3', { origin: [2, 0, 0] })
    expect(() => run(repo, {
      id: 'pl1', kind: 'plane',
      definition: { mode: 'three_point', p1: '@p1', p2: '@p2', p3: '@p3' },
    })).toThrow(/collinear/)
  })

  it('plane_point projects the reference origin onto the point along the normal', () => {
    const repo = initGlobalRepo()
    repo.register('pt', { origin: [1, 2, 7] })
    const res = run(repo, {
      id: 'pl1', kind: 'plane',
      definition: { mode: 'plane_point', plane: '@builtin_plane_front', point: '@pt' },
    })
    close(res.plane.origin, [0, 0, 7])
    close(res.plane.normal, [0, 0, 1])
  })

  it('line_angle uses the line as the x-axis', () => {
    const repo = new Repository()
    repo.register('ln', { start: [0, 0, 0], end: [1, 0, 0] })
    const res = run(repo, {
      id: 'pl1', kind: 'plane',
      definition: { mode: 'line_angle', line: '@ln', angle: 0 },
    })
    close(res.plane.origin, [0, 0, 0])
    close(res.plane.x_axis, [1, 0, 0])
    close(res.plane.y_axis, [0, 0, 1])
    close(res.plane.normal, [0, -1, 0])
  })

  it('on_face places the frame at the face centroid with the face normal', () => {
    const repo = new Repository()
    repo.register('f1', { centroid: [1, 1, 1], normal: [0, 0, 1], type: 'face' })
    const res = run(repo, {
      id: 'pl1', kind: 'plane',
      definition: { mode: 'on_face', face: '@f1' },
    })
    close(res.plane.origin, [1, 1, 1])
    close(res.plane.normal, [0, 0, 1])
    // x and y are orthonormal and perpendicular to the normal
    close(res.plane.x_axis, [res.plane.x_axis[0], res.plane.x_axis[1], 0])
    expect(res.plane.x_axis[0] * res.plane.normal[0]
      + res.plane.x_axis[1] * res.plane.normal[1]
      + res.plane.x_axis[2] * res.plane.normal[2]).toBeCloseTo(0, 9)
  })

  it('on_face_edge_angle aligns x to the in-plane edge direction', () => {
    const repo = new Repository()
    repo.register('f1', { centroid: [0, 0, 0], normal: [0, 0, 1], type: 'face' })
    repo.register('e1', { start: [0, 0, 0], end: [1, 0, 0], type: 'edge' })
    const res = run(repo, {
      id: 'pl1', kind: 'plane',
      definition: { mode: 'on_face_edge_angle', face: '@f1', edge: '@e1', angle: 0 },
    })
    close(res.plane.origin, [0, 0, 0])
    close(res.plane.x_axis, [1, 0, 0])
    close(res.plane.y_axis, [0, 1, 0])
    close(res.plane.normal, [0, 0, 1])
  })

  it('edge_point builds a frame from an edge and an off-edge point', () => {
    const repo = new Repository()
    repo.register('e1', { start: [0, 0, 0], end: [2, 0, 0] })
    repo.register('pt', { origin: [1, 1, 0] })
    const res = run(repo, {
      id: 'pl1', kind: 'plane',
      definition: { mode: 'edge_point', edge: '@e1', point: '@pt' },
    })
    close(res.plane.origin, [1, 1, 0])
    close(res.plane.x_axis, [1, 0, 0])
    close(res.plane.y_axis, [0, -1, 0])
    close(res.plane.normal, [0, 0, -1])
  })

  it('applies an in-plane rotation after building the frame', () => {
    const repo = initGlobalRepo()
    const res = run(repo, {
      id: 'pl1', kind: 'plane',
      definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 5, rotation: 90 },
    })
    close(res.plane.origin, [0, 0, 5])
    close(res.plane.x_axis, [0, 1, 0])
    close(res.plane.y_axis, [-1, 0, 0])
    close(res.plane.normal, [0, 0, 1])
  })

  it('throws on an unknown mode', () => {
    const repo = initGlobalRepo()
    expect(() => run(repo, { id: 'pl1', kind: 'plane', definition: { mode: 'bogus' } }))
      .toThrow(/unknown plane mode/)
  })
})
