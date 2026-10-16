// The cosmetic-thread display's selection layer, pure: which solve results
// yield a curve, and what a bad or missing one does. The viewport's own wiring
// is the component test beside this file.
import { describe, it, expect } from 'vitest'
import { collectThreadCurves } from '../threadHelices'
import type { SketchData } from '@/types/cad'

const solved = { points: [], entities: [] } as unknown as SketchData['solved']

const helix = (points: [number, number, number][]) => ({
  center: [0, 0, 0] as [number, number, number],
  axis: [0, 0, 1] as [number, number, number],
  radius: 2.5, pitch: 1, turns: 2, points,
})

describe('collectThreadCurves', () => {
  it('collects one curve per helix of every hole that reports a thread', () => {
    const curves = collectThreadCurves(
      [{ id: 'h1', kind: 'hole' }, { id: 'h2', kind: 'hole' }, { id: 'ex1', kind: 'extrude' }],
      {
        h1: { solved, thread: { designation: 'M6x1', nominal: 6, pitch: 1, helices: [helix([[0, 0, 0], [1, 0, 1]])] } },
        h2: { solved, thread: { designation: 'M6x1', nominal: 6, pitch: 1, helices: [helix([[0, 0, 0], [1, 0, 1]]), helix([[5, 5, 0], [6, 5, 1]])] } },
        ex1: { solved, curve: { kind: 'spline', points: [[0, 0, 0], [1, 1, 1]] } },
      },
    )
    expect(curves.map((c) => c.featureId)).toEqual(['h1', 'h2', 'h2'])
  })

  it('skips holes without a thread, and results that are malformed', () => {
    const curves = collectThreadCurves(
      [{ id: 'h1', kind: 'hole' }, { id: 'h2', kind: 'hole' }, { id: 'h3', kind: 'hole' }],
      {
        h1: { solved },
        h2: { solved, thread: { designation: 'M6x1', nominal: 6, pitch: 1, helices: [helix([[0, 0, 0]])] } },
        // A payload with no helices at all: the shape a result cached by an
        // older build could hold, which the reader must survive.
        h3: { solved, thread: { designation: 'M6x1', nominal: 6, pitch: 1 } as unknown as SketchData['thread'] },
      },
    )
    expect(curves).toEqual([])
  })

  it('has nothing to draw without a solve result bag', () => {
    expect(collectThreadCurves([{ id: 'h1', kind: 'hole' }], undefined)).toEqual([])
  })
})
