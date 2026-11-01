// @vitest-environment node
//
// The pure half of the frame report: featureFrames filters a solve result to
// sketch and plane features, rounds the axes and drops a refused feature. The
// real-kernel half, a sketch on a face and an add_plane feature built through
// the drive, is featureFramesReal.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { featureFrames } from '../featureFrames'

describe('featureFrames', () => {
  it('reports only sketch and plane features, rounded, and skips a refused one', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch', entities: [] },
        { id: 'pl1', kind: 'plane', definition: { mode: 'offset' } },
        { id: 'ex1', kind: 'extrude', sketch: '$sk1' },
        { id: 'sk2', kind: 'sketch', entities: [] },
      ],
    } as PartDoc
    const result = {
      sk1: {
        status: 'underconstrained',
        plane_transform: {
          rotation: [1, 0, 0, 0, Math.PI, 0, 0, 0, 1],
          origin: [0, 0, 0.1 + 0.2],
        },
      },
      pl1: {
        status: 'ok',
        plane: {
          origin: [0, 0, 5],
          x_axis: [Math.PI, 0, 0],
          y_axis: [0, 0, -1],
          normal: [0, 0, 1],
        },
      },
      ex1: {
        status: 'ok',
        // Not a frame-bearing kind: a transform on an extrude must not leak in.
        plane_transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [9, 9, 9] },
      },
      sk2: { status: 'exception', exception: "plane 'pl2' did not resolve" },
    }
    expect(featureFrames(doc, result)).toEqual({
      sk1: {
        origin: [0, 0, 0.3],
        x_axis: [1, 0, 0],
        y_axis: [0, 3.141593, 0],
        normal: [0, 0, 1],
      },
      pl1: { origin: [0, 0, 5], x_axis: [3.141593, 0, 0], y_axis: [0, 0, -1], normal: [0, 0, 1] },
    })
  })

  it('returns an empty map without a document or a solve result', () => {
    expect(featureFrames(null, {})).toEqual({})
    expect(featureFrames({ version: 1, kind: 'part', features: [] }, null)).toEqual({})
  })
})
