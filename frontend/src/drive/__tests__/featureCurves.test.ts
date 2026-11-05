// @vitest-environment node
//
// The pure half of the helix placement report: featureCurves reads a solve
// result, rounds the points and derived values, takes `hand` from the document
// and keeps a suppressed or thrown helix out. The real-kernel half, a helix on
// a built cylinder and the sweep that consumes its start, is helixReplyReal.test.ts.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { featureCurves } from '../featureCurves'
import { runReply } from '../mcpDocRef'
import { DocHandleStore } from '../docHandleStore'

function helixDoc(hand: 'right' | 'left' = 'right'): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'hx1', kind: 'helix', helix: { hand } },
      { id: 'hx2', kind: 'helix', helix: {} },
      { id: 'hx3', kind: 'helix', helix: {} },
      { id: 'sk1', kind: 'sketch', entities: [] },
    ],
  } as unknown as PartDoc
}

function helixResult(axis: number[]) {
  return {
    hx1: {
      status: 'ok',
      helix: { radius: 5, pitch: 2.5, turns: 2, height: 5, helix_angle: 4.55, length: 50 },
      placement: {
        origin: [0, 0, 0.1 + 0.2],
        axis,
        start: [5, 0, 0.30000000000000004],
        end: [5, 0, -4.999999999999999],
      },
    },
  }
}

describe('featureCurves', () => {
  it('reports one rounded entry per clean helix and skips failed or suppressed rows', () => {
    const result = {
      ...helixResult([0, -1, 0]),
      hx2: { status: 'exception', exception: 'helix threw' },
      hx3: { status: 'suppressed' },
      sk1: { status: 'ok' },
    }
    expect(featureCurves(helixDoc('left'), result)).toEqual({
      hx1: {
        origin: [0, 0, 0.3],
        axis: [0, -1, 0],
        start: [5, 0, 0.3],
        end: [5, 0, -5],
        radius: 5,
        pitch: 2.5,
        turns: 2,
        height: 5,
        hand: 'left',
      },
    })
  })

  it('reports no entries without a document or a solve result', () => {
    expect(featureCurves(null, {})).toEqual({})
    expect(featureCurves({ version: 1, kind: 'part', features: [] }, null)).toEqual({})
  })

  it('reads axis as the climb direction: reverse negates it and hand stays', () => {
    const normal = featureCurves(helixDoc('right'), helixResult([0, 1, 0])).hx1
    const reverse = featureCurves(helixDoc('right'), helixResult([0, -1, 0])).hx1
    expect(reverse.axis).toEqual([0, -1, 0])
    expect(normal.axis).toEqual([0, 1, 0])
    expect(reverse.hand).toBe(normal.hand)
  })

  it('omits the curves key from a run reply when the map is empty', () => {
    const reply = runReply({
      ok: true,
      solved: true,
      outcome: { steps: [] },
      doc: null,
      docHash: null,
      solve: {},
      features: [],
      curves: {},
    }, false, new DocHandleStore())
    expect(reply).not.toHaveProperty('curves')
  })
})
