// @vitest-environment node
//
// The pure half of the frame report: featureFrames filters a solve result to
// The pure half of the frame report: featureFrames filters a solve result to
// sketch and plane features, rounds the axes, drops a refused feature and, in
// the changed mode a run reply uses, keeps only the frames this call touched or
// moved. frameConflicts compares the frames of sketches that name one stored
// plane query and names the pair whose frames drifted. The real-kernel half, a
// sketch on a face and an add_plane feature built through the drive, is
// featureFramesReal.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { featureFrames, frameConflicts, type FeatureFrame, type FeatureFrameMap } from '../featureFrames'

function frame(origin: number[], axes: Partial<Pick<FeatureFrame, 'x_axis' | 'y_axis'>> = {}): FeatureFrame {
  return {
    origin,
    x_axis: axes.x_axis ?? [1, 0, 0],
    y_axis: axes.y_axis ?? [0, 1, 0],
    normal: [0, 0, 1],
  }
}

/** Two sketches on one stored face query, in log order. */
function pairDoc(planeA = '?body_ex1:flatface', planeB = planeA): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk8', kind: 'sketch', plane: planeA },
      { id: 'sk9', kind: 'sketch', plane: planeB },
    ],
  } as PartDoc
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

describe('frameConflicts', () => {
  it('names both sketches and the origin distance when one query resolved two frames', () => {
    // The ANC101 pair: the boss removed area from the canted face, so the
    // second sketch's centroid moved 0.348 mm while its query stayed the same.
    const frames: FeatureFrameMap = {
      sk8: frame([1, 2, 3]),
      sk9: frame([1.348, 2, 3]),
    }
    const notes = frameConflicts(pairDoc(), frames)
    expect(notes).toHaveLength(1)
    expect(notes[0].ids).toEqual(['sk8', 'sk9'])
    expect(notes[0].text).toContain('sk8 and sk9 share the face query "?body_ex1:flatface"')
    expect(notes[0].text).toContain('their resolved origins differ by 0.348 mm')
    expect(notes[0].text).toContain("Dimension sk9 against projected edges of the face")
  })

  it('says nothing when both sketches resolved the same frame', () => {
    const frames: FeatureFrameMap = {
      sk8: frame([1, 2, 3]),
      sk9: frame([1, 2, 3]),
    }
    expect(frameConflicts(pairDoc(), frames)).toEqual([])
  })

  it('does not compare sketches on different queries, or a builtin pair', () => {
    expect(frameConflicts(pairDoc('?a:flatface', '?b:flatface'), {
      sk8: frame([0, 0, 0]),
      sk9: frame([10, 0, 0]),
    })).toEqual([])
    // A builtin plane resolves to the same frame every solve; two sketches on
    // it cannot drift even though they share the query.
    expect(frameConflicts(pairDoc('@builtin_plane_front'), {
      sk8: frame([0, 0, 0]),
      sk9: frame([0, 0, 0]),
    })).toEqual([])
  })

  it('groups the two ref spellings of one plane as one query', () => {
    const notes = frameConflicts(pairDoc('$sk2', '@sk2'), {
      sk8: frame([0, 0, 0]),
      sk9: frame([0, 0, 0.5]),
    })
    expect(notes).toHaveLength(1)
    expect(notes[0].ids).toEqual(['sk8', 'sk9'])
    expect(notes[0].text).toContain('share the face query "$sk2"')
    expect(notes[0].text).toContain('0.5 mm')
  })

  it('reports an axes-only drift without claiming a zero origin distance', () => {
    const notes = frameConflicts(pairDoc(), {
      sk8: frame([1, 2, 3]),
      sk9: frame([1, 2, 3], { x_axis: [0, 1, 0], y_axis: [-1, 0, 0] }),
    })
    expect(notes).toHaveLength(1)
    expect(notes[0].text).toContain('their resolved in-plane axes differ')
    expect(notes[0].text).not.toContain('differ by 0')
  })

  it('names the distance in the document unit', () => {
    const inch = { ...pairDoc(), length_unit: 'inch' } as PartDoc
    const notes = frameConflicts(inch, {
      sk8: frame([0, 0, 0]),
      sk9: frame([0.25, 0, 0]),
    })
    expect(notes[0].text).toContain('0.25 in')
  })

  it('skips a sketch whose solve produced no frame', () => {
    expect(frameConflicts(pairDoc(), { sk8: frame([0, 0, 0]) })).toEqual([])
  })
})
