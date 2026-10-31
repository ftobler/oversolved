// Unit tests for the `origin_rotation` plane mode: a world point (or a resolved
// point/vertex ref) plus a rotation about an axis, which is the code-CAD
// `transformed(offset=..., rotate=...)` placement that every other mode needs
// helper geometry to express. Pure frame math, so no OCC here.

import { describe, it, expect } from 'vitest'
import { initGlobalRepo, Repository } from '../../query'
import { solvePlane } from '../plane'
import type { Body } from '../../types3d'

type Dict = Record<string, unknown>

function run(repo: Repository, feature: Dict, bodyStore: Record<string, Body> = {}) {
  return solvePlane(null, null, null, feature, repo, bodyStore)
}

function planeFeature(id: string, definition: Dict): Dict {
  return { id, kind: 'plane', definition }
}

function close(a: number[], b: number[]) {
  expect(a.length).toBe(b.length)
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9))
}

const SIN60 = Math.sin(Math.PI / 3)
const COS60 = Math.cos(Math.PI / 3)

describe('solvePlane origin_rotation', () => {
  it('places the world XY frame at a stored origin', () => {
    const res = run(initGlobalRepo(), planeFeature('pl1', { mode: 'origin_rotation', origin: [3, -2, 5] }))
    expect(res.status).toBe('ok')
    close(res.plane.origin, [3, -2, 5])
    close(res.plane.x_axis, [1, 0, 0])
    close(res.plane.y_axis, [0, 1, 0])
    close(res.plane.normal, [0, 0, 1])
  })

  it('takes the origin from a resolved vertex pick', () => {
    // The kernel's vertex lineage registers the corner under its ancestry query
    // with type vertex, which is what a `select` kind "vertex" returns.
    const repo = initGlobalRepo()
    repo.register('vq6', { type: 'vertex', origin: [10, 0, 6] })
    const res = run(repo, planeFeature('pl1', { mode: 'origin_rotation', origin: '@vq6' }))
    close(res.plane.origin, [10, 0, 6])
    close(res.plane.normal, [0, 0, 1])
  })

  it('refuses an origin ref that does not resolve, naming it', () => {
    expect(() => run(initGlobalRepo(), planeFeature('pl1', { mode: 'origin_rotation', origin: '@nope' })))
      .toThrow(/origin not found: "@nope"/)
  })

  it('refuses an origin that is not three finite numbers', () => {
    expect(() => run(initGlobalRepo(), planeFeature('pl1', { mode: 'origin_rotation', origin: [1, 2] })))
      .toThrow(/origin must be three finite numbers/)
    expect(() => run(initGlobalRepo(), planeFeature('pl1', { mode: 'origin_rotation', origin: [1, 2, 'x'] })))
      .toThrow(/origin must be three finite numbers/)
  })

  it('refuses the mode with no origin at all', () => {
    expect(() => run(initGlobalRepo(), planeFeature('pl1', { mode: 'origin_rotation' })))
      .toThrow(/origin_rotation needs an origin/)
  })

  it('tilts the frame about a named world axis by the angle', () => {
    // The Ex015 placement: origin above the plate, 60 degrees about world +X.
    // Right-hand rotation about +X turns +Y toward +Z and the normal toward -Y.
    const res = run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, -1.5, 1], rotation_axis: 'x', rotation_angle: 60,
    }))
    close(res.plane.origin, [0, -1.5, 1])
    close(res.plane.x_axis, [1, 0, 0])
    close(res.plane.y_axis, [0, COS60, SIN60])
    close(res.plane.normal, [0, -SIN60, COS60])
  })

  it('tilts about a stored axis vector the same way as the letter', () => {
    const byVector = run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, -1.5, 1], rotation_axis: [1, 0, 0], rotation_angle: 60,
    }))
    close(byVector.plane.normal, [0, -SIN60, COS60])
    const byLetter = run(initGlobalRepo(), planeFeature('pl2', {
      mode: 'origin_rotation', origin: [0, -1.5, 1], rotation_axis: 'x', rotation_angle: 60,
    }))
    close(byVector.plane.y_axis, byLetter.plane.y_axis)
  })

  it('refuses an axis letter outside the wire enum spelling', () => {
    // One spelling path: the kernel accepts exactly the lowercase letters the
    // schema enum names, so a lenient kernel reading cannot outlive the wire check.
    expect(() => run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, 0, 0], rotation_axis: 'X', rotation_angle: 60,
    }))).toThrow(/rotation_axis must be "x", "y" or "z" or three finite numbers/)
  })

  it('rotates about an arbitrary axis through the parent axes', () => {
    const res = run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [1, 1, 1], rotation_axis: [0, 0, 1], rotation_angle: 90,
    }))
    close(res.plane.x_axis, [0, 1, 0])
    close(res.plane.y_axis, [-1, 0, 0])
    close(res.plane.normal, [0, 0, 1])
  })

  it('inherits the named parent plane axes before rotating', () => {
    const parent = run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [1, 2, 3], plane: '@builtin_plane_top',
    }))
    close(parent.plane.origin, [1, 2, 3])
    close(parent.plane.x_axis, [1, 0, 0])
    close(parent.plane.y_axis, [0, 0, -1])
    close(parent.plane.normal, [0, 1, 0])

    // Rotating the Top frame about world +X: its y (world -Z) swings toward +Y.
    const tilted = run(initGlobalRepo(), planeFeature('pl2', {
      mode: 'origin_rotation', origin: [1, 2, 3], plane: '@builtin_plane_top',
      rotation_axis: 'x', rotation_angle: 60,
    }))
    close(tilted.plane.x_axis, [1, 0, 0])
    close(tilted.plane.y_axis, [0, SIN60, -COS60])
    close(tilted.plane.normal, [0, COS60, SIN60])
  })

  it('refuses a parent plane that does not resolve, naming it', () => {
    expect(() => run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, 0, 0], plane: '@nope',
    }))).toThrow(/plane not found: "@nope"/)
  })

  it('refuses an empty parent plane like the other modes do', () => {
    // Leaving `plane` out is the world XY spelling; an empty string is the same
    // mistake the offset and point modes refuse with `plane not found: ""`.
    expect(() => run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, 0, 0], plane: '',
    }))).toThrow(/plane not found: ""/)
  })

  it('refuses half a rotation pair by naming both fields', () => {
    expect(() => run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, 0, 0], rotation_angle: 60,
    }))).toThrow(/rotation_angle needs rotation_axis/)
    expect(() => run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, 0, 0], rotation_axis: 'x',
    }))).toThrow(/rotation_axis needs rotation_angle/)
  })

  it('refuses a zero-length rotation axis', () => {
    expect(() => run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, 0, 0], rotation_axis: [0, 0, 0], rotation_angle: 60,
    }))).toThrow(/rotation_axis/)
  })

  it('refuses a rotation axis that is not a letter or a vector', () => {
    expect(() => run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, 0, 0], rotation_axis: 'diagonal', rotation_angle: 60,
    }))).toThrow(/rotation_axis must be "x", "y" or "z" or three finite numbers/)
  })

  it('still applies the in-plane rotation after the tilt', () => {
    // `rotation` is the same spin every mode applies last, so a tilt and a
    // 90 degree in-plane turn compose rather than replace each other.
    const res = run(initGlobalRepo(), planeFeature('pl1', {
      mode: 'origin_rotation', origin: [0, 0, 0], rotation_axis: 'x', rotation_angle: 60, rotation: 90,
    }))
    close(res.plane.normal, [0, -SIN60, COS60])
    close(res.plane.x_axis, [0, COS60, SIN60])
    close(res.plane.y_axis, [-1, 0, 0])
  })

  it('registers the solved frame under the feature id', () => {
    const repo = initGlobalRepo()
    run(repo, planeFeature('plTilt', {
      mode: 'origin_rotation', origin: [0, -1.5, 1], rotation_axis: 'y', rotation_angle: 30,
    }))
    const reg = repo.elements.get('plTilt') as Dict
    expect(reg).toBeTruthy()
    expect(reg.type).toBe('plane')
    close(reg.origin as number[], [0, -1.5, 1])
  })
})
