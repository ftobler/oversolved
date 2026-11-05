// @vitest-environment node
//
// The authored projection behind the step seed and a version-3 journal entry:
// `part_style` and each feature's `initial` are the solve write-back's fields,
// so the hash must not move when they do, and must move when anything the
// author wrote changes.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { authoredHashOf, docHashOf } from '../docHash'

function doc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: 'l1', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0] },
      },
      { id: 'ex1', kind: 'extrude', extrude: { distance: 5 } },
    ],
    part_style: { body_ex1: { name: 'part 1', color: '#ff0000' } },
  } as PartDoc
}

describe('authoredHashOf', () => {
  it('ignores the solve write-back fields', () => {
    const before = doc()
    const baked = structuredClone(before)
    const bakedSketch = baked.features![0]
    if (bakedSketch.kind === 'sketch') bakedSketch.initial = { l1: [0.000001, 0, 9.999999, 0] }
    baked.part_style!.body_ex1.name = 'part 7'
    baked.part_style!.body_ex1.color = '#00ff00'
    expect(docHashOf(baked)).not.toBe(docHashOf(before))
    expect(authoredHashOf(baked)).toBe(authoredHashOf(before))
  })

  it('still follows authored fields', () => {
    const before = doc()
    const renamed = structuredClone(before)
    renamed.features![0].label = 'Renamed'
    expect(authoredHashOf(renamed)).not.toBe(authoredHashOf(before))

    const moved = structuredClone(before)
    const movedSketch = moved.features![0]
    if (movedSketch.kind === 'sketch') movedSketch.entities!.push({ id: 'l2', kind: 'line' })
    expect(authoredHashOf(moved)).not.toBe(authoredHashOf(before))
  })
})
