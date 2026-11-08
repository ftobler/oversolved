// @vitest-environment node
//
// The headless solver write-back: bake geometry and reconcile part_style from
// the body set the solve reported. A consumed body must lose its colour entry
// rather than leaving a stale id in the document forever. The report also says
// whether fresh sketch geometry was installed, which is the headless settle's
// cue to solve the written document again.

import { describe, it, expect } from 'vitest'
import type { BodyResult, PartDoc } from '@/types/cad'
import { applySolveToDoc } from '../solveWriteBack'

function body(id: string): BodyResult {
  return { id, created_by: `feature_${id}`, modified_by: [] }
}

function doc(style: Record<string, unknown>): PartDoc {
  return { version: 1, kind: 'part', features: [], part_style: style } as unknown as PartDoc
}

describe('applySolveToDoc', () => {
  it('drops the colour entry of a body the solve consumed', () => {
    const { doc: written } = applySolveToDoc(
      doc({ body_ex1: { name: 'part 1', color: '#111111' }, body_ex2: { name: 'part 2', color: '#222222' } }),
      { result: {}, bodies: { body_ex1: body('body_ex1') } },
    )
    expect(written.part_style).toHaveProperty('body_ex1')
    expect(written.part_style).not.toHaveProperty('body_ex2')
  })

  it('frees the consumed part number for the next new body', () => {
    const { doc: written } = applySolveToDoc(
      doc({ body_ex1: { name: 'part 1', color: '#111111' }, body_ex2: { name: 'part 2', color: '#222222' } }),
      { result: {}, bodies: { body_ex1: body('body_ex1'), body_ex3: body('body_ex3') } },
    )
    expect(written.part_style!.body_ex3.name).toBe('part 2')
  })

  it('leaves no style behind when the solve has no body', () => {
    const { doc: written } = applySolveToDoc(
      doc({ body_ex1: { name: 'part 1', color: '#111111' } }),
      { result: {}, bodies: {} },
    )
    expect(written.part_style).toEqual({})
  })

  it('does not touch part_style when the response carries no body set', () => {
    const { doc: written } = applySolveToDoc(doc({ body_ex1: { name: 'kept' } }), { result: {} })
    expect(written.part_style).toEqual({ body_ex1: { name: 'kept' } })
  })
})

describe('applySolveToDoc report', () => {
  const sketchDoc = (initial?: Record<string, number[]>): PartDoc => ({
    version: 1,
    kind: 'part',
    features: [
      ...(initial === undefined ? [] : [{ id: 'sk1', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }], initial }]),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
    ],
  } as unknown as PartDoc)

  it('reports the sketch whose geometry was installed, in document order', () => {
    const first = applySolveToDoc(sketchDoc({ l1: [0, 0, 1, 0] }), {
      result: {
        sk1: { status: 'underconstrained', geometry: { l1: [0, 0, 2, 0] } },
        ex1: { status: 'ok', geometry: { x: [1] } },
      },
    })
    expect(first.geometryMoved).toBe(true)
    expect(first.movedFeatureIds).toEqual(['sk1'])
    const writtenSketch = first.doc.features!.find(feature => feature.id === 'sk1') as
      { initial?: Record<string, number[]> } | undefined
    expect(writtenSketch?.initial).toEqual({ l1: [0, 0, 2, 0] })

    const second = applySolveToDoc(first.doc, {
      result: { sk1: { status: 'underconstrained', geometry: { l1: [0, 0, 2, 0] } } },
    })
    expect(second.geometryMoved).toBe(false)
    expect(second.movedFeatureIds).toEqual([])
  })

  it('lists only sketches: a non-sketch geometry row is not a move', () => {
    const written = applySolveToDoc(sketchDoc(), {
      result: { ex1: { status: 'ok', geometry: { x: [1] } } },
    })
    expect(written.geometryMoved).toBe(false)
  })
})
