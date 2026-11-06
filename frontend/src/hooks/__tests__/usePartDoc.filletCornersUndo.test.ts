// One fillet_corners step over four corners is one history entry, whatever the
// arc count: undo returns to the pre-fillet document and redo restores the arcs.
// Runs through the real usePartDoc with the mocked document/solver seams.

import { describe, it, expect, vi } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runPartTranscript, type TranscriptStep } from './historyTranscript'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

function rectDoc(): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'b', kind: 'line' },
        { id: 'r', kind: 'line' },
        { id: 't', kind: 'line' },
        { id: 'l', kind: 'line' },
      ],
      initial: {
        b: [0, 0, 80, 0],
        r: [80, 0, 80, 60],
        t: [80, 60, 0, 60],
        l: [0, 60, 0, 0],
      },
      constraints: [
        { id: 'k_bl', kind: 'coincident', a: '$bstart', b: '$lend' },
        { id: 'k_br', kind: 'coincident', a: '$bend', b: '$rstart' },
        { id: 'k_tr', kind: 'coincident', a: '$rend', b: '$tstart' },
        { id: 'k_tl', kind: 'coincident', a: '$tend', b: '$lstart' },
      ],
    }],
  }
}

const fillet: TranscriptStep = {
  kind: 'mutation',
  mutation: {
    type: 'fillet_corners', featureId: 'sk', radius: 5,
    corners: [
      { a: 'b', aVertex: 'start', b: 'l', bVertex: 'end' },
      { a: 'b', aVertex: 'end', b: 'r', bVertex: 'start' },
      { a: 'r', aVertex: 'end', b: 't', bVertex: 'start' },
      { a: 't', aVertex: 'end', b: 'l', bVertex: 'start' },
    ],
  },
}

describe('usePartDoc fillet_corners history', () => {
  it('keeps a four-corner fillet as one undo entry', () => {
    const pre = rectDoc()
    const snapshots: (PartDoc | null)[] = []
    const result = runPartTranscript(pre, [
      fillet,
      { kind: 'undo' },
      { kind: 'redo' },
    ], { onStep: doc => { snapshots.push(doc) } })

    const [forward, undone, redone] = snapshots
    expect(forward).not.toEqual(pre)
    expect(undone).toEqual(pre)
    expect(redone).toEqual(forward)

    expect(result.undoLabels).toHaveLength(1)
    expect(result.undoLabels[0]).toBe('fillet 4 corner(s) at radius 5 in sk')
    expect(result.redoLabels).toHaveLength(0)

    const arcs = (doc: PartDoc | null) => {
      const feature = doc?.features?.[0]
      if (feature?.kind !== 'sketch') return 0
      return (feature.entities ?? []).filter(entity => entity.kind === 'arc').length
    }
    expect(arcs(forward)).toBe(4)
    expect(arcs(redone)).toBe(4)
    expect(arcs(undone)).toBe(0)
  })
})
