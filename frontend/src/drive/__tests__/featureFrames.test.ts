// @vitest-environment node
//
// The pure half of the frame report: featureFrames filters a solve result to
// sketch and plane features, rounds the axes, drops a refused feature and, in
// the changed mode a run reply uses, keeps only the frames this call touched or
// moved. The real-kernel half, a sketch on a face and an add_plane feature
// built through the drive, is featureFramesReal.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { featureFrames, type FeatureFrame } from '../featureFrames'

function frame(origin: number[]): FeatureFrame {
  return { origin, x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
}

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

function planeResult(origin: number[]) {
  return { status: 'ok', plane: { origin, x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] } }
}

describe('featureFrames', () => {
  it('reports only sketch and plane features, rounded, and skips a refused one', () => {
    const result = {
      sk1: {
        status: 'underconstrained',
        plane_transform: {
          rotation: [1, 0, 0, 0, Math.PI, 0, 0, 0, 1],
          origin: [0, 0, 0.1 + 0.2],
        },
      },
      pl1: { status: 'ok', plane: { origin: [0, 0, 5], x_axis: [Math.PI, 0, 0], y_axis: [0, 0, -1], normal: [0, 0, 1] } },
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

  it('keeps a touched frame and drops an unchanged one when a baseline is given', () => {
    const result = { sk1: planeResult([0, 0, 0]), sk2: planeResult([0, 0, 0]) }
    const baseline = { sk1: frame([0, 0, 0]), sk2: frame([0, 0, 0]) }
    expect(featureFrames(doc, result, { baseline, touched: new Set(['sk2']), mode: 'changed' }))
      .toEqual({ sk2: frame([0, 0, 0]) })
  })

  it('reports a frame that moved without the sketch being touched', () => {
    // An upstream edit reshaped the face the sketch sits on: the feature was not
    // named by the steps, but its resolved frame is not the input's any more.
    const result = { sk1: planeResult([0, 5, 0]), sk2: planeResult([0, 0, 0]) }
    const baseline = { sk1: frame([0, 0, 0]), sk2: frame([0, 0, 0]) }
    expect(featureFrames(doc, result, { baseline, touched: new Set(), mode: 'changed' }))
      .toEqual({ sk1: frame([0, 5, 0]) })
  })

  it('reports every frame in all mode, baseline or not', () => {
    const result = { sk1: planeResult([0, 0, 0]), sk2: planeResult([0, 0, 0]) }
    const baseline = { sk1: frame([0, 0, 0]), sk2: frame([0, 0, 0]) }
    expect(Object.keys(featureFrames(doc, result, { baseline, touched: new Set(), mode: 'all' })).sort())
      .toEqual(['sk1', 'sk2'])
  })

  it('keeps a suppressed or thrown feature out in every mode', () => {
    const result = {
      sk1: planeResult([0, 0, 0]),
      sk2: { status: 'exception', exception: 'sketch threw' },
    }
    const touched = new Set(['sk1', 'sk2'])
    for (const mode of ['changed', 'all'] as const) {
      const frames = featureFrames(doc, result, { baseline: { sk1: frame([0, 0, 0]) }, touched, mode })
      expect(frames.sk1).toBeDefined()
      expect(frames.sk2).toBeUndefined()
    }
  })
})
