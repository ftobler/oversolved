import { describe, it, expect } from 'vitest'
import { projectWorldToFrame, type Frame3D } from './types3d'

describe('projectWorldToFrame', () => {
  const builtinTop: Frame3D = {
    // Rx(-90deg): local x -> world x, local y -> world -z, normal -> world y.
    origin: [0, 0, 0],
    x_axis: [1, 0, 0],
    y_axis: [0, 0, -1],
    normal: [0, 1, 0],
  }

  it('maps the document origin to [0,0] on a plane through the global origin', () => {
    expect(projectWorldToFrame([0, 0, 0], builtinTop)).toEqual([0, 0])
  })

  it('returns nonzero local coords for the origin on an offset plane', () => {
    // Same axes, but the plane origin sits at world (5, 10, -2).
    const offset: Frame3D = { ...builtinTop, origin: [5, 10, -2] }
    // d = (0,0,0) - (5,10,-2) = (-5,-10,2)
    // local_x = d . x_axis = -5
    // local_y = d . y_axis = d . (0,0,-1) = -2
    expect(projectWorldToFrame([0, 0, 0], offset)).toEqual([-5, -2])
  })

  it('projects an off-plane point to the foot of its perpendicular', () => {
    // The world point's component along the normal is discarded.
    const frame: Frame3D = {
      origin: [0, 0, 0],
      x_axis: [1, 0, 0],
      y_axis: [0, 1, 0],
      normal: [0, 0, 1],
    }
    expect(projectWorldToFrame([3, 4, 99], frame)).toEqual([3, 4])
  })
})
