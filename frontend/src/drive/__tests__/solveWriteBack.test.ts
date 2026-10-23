// @vitest-environment node
//
// The headless solver write-back: bake geometry and reconcile part_style from
// the body set the solve reported. A consumed body must lose its colour entry
// rather than leaving a stale id in the document forever.

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
    const written = applySolveToDoc(
      doc({ body_ex1: { name: 'part 1', color: '#111111' }, body_ex2: { name: 'part 2', color: '#222222' } }),
      { result: {}, bodies: { body_ex1: body('body_ex1') } },
    )
    expect(written.part_style).toHaveProperty('body_ex1')
    expect(written.part_style).not.toHaveProperty('body_ex2')
  })

  it('frees the consumed part number for the next new body', () => {
    const written = applySolveToDoc(
      doc({ body_ex1: { name: 'part 1', color: '#111111' }, body_ex2: { name: 'part 2', color: '#222222' } }),
      { result: {}, bodies: { body_ex1: body('body_ex1'), body_ex3: body('body_ex3') } },
    )
    expect(written.part_style!.body_ex3.name).toBe('part 2')
  })

  it('leaves no style behind when the solve has no body', () => {
    const written = applySolveToDoc(
      doc({ body_ex1: { name: 'part 1', color: '#111111' } }),
      { result: {}, bodies: {} },
    )
    expect(written.part_style).toEqual({})
  })

  it('does not touch part_style when the response carries no body set', () => {
    const written = applySolveToDoc(doc({ body_ex1: { name: 'kept' } }), { result: {} })
    expect(written.part_style).toEqual({ body_ex1: { name: 'kept' } })
  })
})
