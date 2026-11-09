// @vitest-environment node
//
// A failed sketch solve must not be baked into the document. Its compromise is
// a least-squares answer, not geometry the user asked for, and writing it back
// reseeds the next solve from a worse place until the reply never settles.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { shouldBakeSketchGeometry } from '../solveResult'
import { applySolveToDoc } from '@/drive/solveWriteBack'

describe('shouldBakeSketchGeometry', () => {
  it('refuses only the overconstrained verdict', () => {
    expect(shouldBakeSketchGeometry({ status: 'overconstrained' })).toBe(false)
    expect(shouldBakeSketchGeometry({ status: 'underconstrained' })).toBe(true)
    expect(shouldBakeSketchGeometry({ status: 'fully_constrained' })).toBe(true)
  })

  it('bakes when the result carries no verdict at all', () => {
    expect(shouldBakeSketchGeometry({})).toBe(true)
    expect(shouldBakeSketchGeometry(undefined)).toBe(true)
  })
})

describe('applySolveToDoc and a failed sketch', () => {
  const doc = (): PartDoc => ({
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 2, 0] },
      },
      {
        id: 'sk2',
        kind: 'sketch',
        entities: [{ id: 'e1', kind: 'point' }],
        initial: { e1: [1, 2] },
      },
    ],
  } as unknown as PartDoc)

  it('keeps an overconstrained sketch and still bakes its sibling', () => {
    const written = applySolveToDoc(doc(), {
      result: {
        sk1: { status: 'overconstrained', geometry: { l1: [0, 0, 3, 0] } },
        sk2: { status: 'underconstrained', geometry: { e1: [3, 4] } },
      },
    })
    expect(written.movedFeatureIds).toEqual(['sk2'])
    expect(written.geometryMoved).toBe(true)
    const sk1 = written.doc.features!.find(f => f.id === 'sk1') as { initial?: Record<string, number[]> }
    const sk2 = written.doc.features!.find(f => f.id === 'sk2') as { initial?: Record<string, number[]> }
    expect(sk1.initial).toEqual({ l1: [0, 0, 2, 0] })
    expect(sk2.initial).toEqual({ e1: [3, 4] })
  })

  it('reports no move when the only sketch failed', () => {
    const written = applySolveToDoc(doc(), {
      result: { sk1: { status: 'overconstrained', geometry: { l1: [0, 0, 3, 0] } } },
    })
    expect(written.movedFeatureIds).toEqual([])
    expect(written.geometryMoved).toBe(false)
  })
})
