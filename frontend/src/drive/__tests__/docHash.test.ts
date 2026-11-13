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

function projectedDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      entities: [{ id: 'p1', kind: 'circle' }],
      initial: { p1: [0, 0, 5] },
      constraints: [
        { id: 'proj_p1', kind: 'projection', target: '$p1', source: '?edge;circle' },
        {
          id: 'proj_face', kind: 'projection', source: '?face',
          members: { 'u|e_aaaa': 'proj_face.eaaaaaaa' },
        },
      ],
    }],
  } as PartDoc
}

describe('authoredHashOf', () => {
  it('ignores the member map and a projected entity kind, but follows excluded', () => {
    const before = projectedDoc()

    const membersChanged = structuredClone(before)
    const membersSketch = membersChanged.features![0]
    if (membersSketch.kind === 'sketch') {
      membersSketch.constraints![1].members = { 'u|e_aaaa': 'proj_face.bbbbbbbb' }
    }
    expect(authoredHashOf(membersChanged)).toBe(authoredHashOf(before))

    const kindChanged = structuredClone(before)
    const kindSketch = kindChanged.features![0]
    if (kindSketch.kind === 'sketch') kindSketch.entities![0].kind = 'ellipse'
    expect(authoredHashOf(kindChanged)).toBe(authoredHashOf(before))

    const excluded = structuredClone(before)
    const excludedSketch = excluded.features![0]
    if (excludedSketch.kind === 'sketch') excludedSketch.constraints![1].excluded = ['u|e_aaaa']
    expect(authoredHashOf(excluded)).not.toBe(authoredHashOf(before))
  })

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
