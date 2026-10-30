// The `mutations` payload now serves the assembly vocabulary beside the part
// one. The part families keep their names and the assembly section names both
// families plus the runnable examples.

import { describe, it, expect } from 'vitest'
import { mutationCatalogPayload } from '../mutationCatalogPayload'

describe('mutationCatalogPayload', () => {
  it('keeps the part families and adds the assembly section', () => {
    const payload = mutationCatalogPayload()
    expect(Object.keys(payload.families)).toEqual(['sketch', 'features', 'picks', 'part style', 'document'])
    expect(Object.keys(payload.assembly.families)).toEqual(['parts', 'mates'])
    expect(payload.assembly.examples.map(example => example.name)).toEqual(['pin_on_plate', 'door_frame'])
  })

  it('lists every assembly mutation exactly once', () => {
    const payload = mutationCatalogPayload()
    const types = Object.values(payload.assembly.families).flat().map(row => row.type)
    expect(types).toHaveLength(16)
    expect(new Set(types).size).toBe(types.length)
    expect(types).toContain('add_part')
    expect(types).toContain('add_mate')
    expect(types).toContain('set_mate_ref')
    expect(types).not.toContain('set_part_fixed_oneshot')
  })

  it('serves the field listings the catalog declares', () => {
    const payload = mutationCatalogPayload()
    const addPart = payload.assembly.families.parts.find(row => row.type === 'add_part')!
    expect(Object.keys(addPart.fields)).toEqual(['handle', 'part', 'position', 'rotation', 'fixed'])
    expect(addPart.fields.handle.required).toBe(true)
    expect(addPart.fields.position.required).toBe(false)
  })
})
