// @vitest-environment node
//
// The world-frame sentence must name every builtin plane, including one added
// to BUILTIN_PLANES later; a hand-typed list would silently omit it.

import { describe, it, expect } from 'vitest'
import { BUILTIN_PLANES } from '@/kernel/solverConstants'
import { worldFrameSentence } from '../worldFrame'

function labelOf(id: string): string {
  return id.replace(/^builtin_plane_/, '').split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

describe('worldFrameSentence', () => {
  it('names every builtin plane', () => {
    const sentence = worldFrameSentence()
    expect(sentence).toContain('World is Y-up.')
    for (const id of Object.keys(BUILTIN_PLANES)) {
      expect(sentence).toContain(`${labelOf(id)}: normal `)
    }
  })

  it('states the axes and the extrude direction', () => {
    const sentence = worldFrameSentence()
    expect(sentence).toContain('Top: normal +Y, sketch x->+X, y->-Z.')
    expect(sentence).toContain('An extrude goes along the plane normal.')
  })
})
