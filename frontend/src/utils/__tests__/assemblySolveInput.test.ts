// One document-to-solve adapter for the browser hook and the headless session:
// the hook re-exports this module's functions, so a field the solve consumes
// cannot be spelled two ways.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import { partSpecs, mateSpecs } from '../assemblySolveInput'
import { partSpecs as hookPartSpecs, mateSpecs as hookMateSpecs } from '@/hooks/useAssemblySolve'

const DOC: AssemblyDoc = {
  kind: 'assembly',
  features: [
    { id: 'inst_left', kind: 'part_instance', instance: {
      handle: 'left', doc_id: 'rail', doc_rev: 3,
      transform: { tx: 1, ty: 2, tz: 3, qx: 0, qy: 0, qz: 0, qw: 1 }, fixed: true,
    } },
    { id: 'm1', kind: 'mate', mate: {
      kind: 'fixed',
      ref_a: { part: 'left', anchor: 'a', anchor_descriptor: {
        geom_hash: '@u|a', kind: 'plane', created_by: 'ex1', point: [0, 0, 0],
      } },
      ref_b: { part: '__assembly', anchor: 'AssemblyTop' },
      flip: true,
      offset: { z: 5 },
      // A hand-edited YAML could carry an inline anchor; the adapter drops it.
      // (Type-level it is not on MateRef, so the cast stands in for the YAML.)
      ...({ ref_b: { part: '__assembly', anchor: 'AssemblyTop', inlineAnchor: { kind: 'point' } } } as object),
    } },
  ],
}

describe('assemblySolveInput', () => {
  it('is the same adapter the browser hook re-exports', () => {
    expect(hookPartSpecs).toBe(partSpecs)
    expect(hookMateSpecs).toBe(mateSpecs)
  })

  it('reads the instance fields the solve consumes', () => {
    expect(partSpecs(DOC)).toEqual([{
      handle: 'left', doc_id: 'rail', fixed: true,
      transform: { tx: 1, ty: 2, tz: 3, qx: 0, qy: 0, qz: 0, qw: 1 },
    }])
  })

  it('drops inlineAnchor and keeps the durable descriptor', () => {
    const [mate] = mateSpecs(DOC)
    expect(mate.ref_a).toEqual({
      part: 'left', anchor: 'a', anchor_descriptor: { geom_hash: '@u|a', kind: 'plane', created_by: 'ex1', point: [0, 0, 0] },
    })
    expect(mate.ref_b).toEqual({ part: '__assembly', anchor: 'AssemblyTop' })
    expect(mate).toMatchObject({ flip: true, offset: { z: 5 } })
  })
})
