// @vitest-environment node
//
// The bulk `add_chamfer` / `add_shell` forms: one call carrying the pick list and
// the parameter must land the same document as the old feature + pick + field
// sequence. The practice round paid 6 and 4 calls for what `add_fillet` already
// did in one.
//
// Also pins the shell sign note: thickness is a magnitude, `direction` carries
// the side, and CadQuery's signed thickness maps positive -> outward.

import { describe, it, expect } from 'vitest'
import { mutationInfoOf } from '../mutationCatalog'

describe('add_chamfer / add_shell document shape and notes', () => {
  it('publishes the inline fields and the bulk note', () => {
    const chamfer = mutationInfoOf('add_chamfer')
    expect(chamfer.fields.edges).toBeDefined()
    expect(chamfer.fields.distance).toBeDefined()
    expect(chamfer.note).toContain('edges')
    expect(chamfer.note).toContain('distance')
    expect(chamfer.note).toContain('same step')

    const shell = mutationInfoOf('add_shell')
    expect(shell.fields.faces).toBeDefined()
    expect(shell.fields.thickness).toBeDefined()
    expect(shell.fields.direction).toBeDefined()
    expect(shell.note).toContain('faces')
    expect(shell.note).toContain('thickness')
    expect(shell.note).toContain('direction')
  })

  it('says the shell sign is the direction field, names inward as the default and maps CadQuery', () => {
    for (const type of ['add_shell', 'set_shell_field'] as const) {
      const note = mutationInfoOf(type).note
      expect(note, type).toBeDefined()
      expect(note, type).toContain('direction: inward|outward')
      expect(note, type).toContain('default is `inward`')
      expect(note, type).toContain('negative value is refused')
      expect(note, type).toContain('CadQuery')
      expect(note, type).toContain('positive -> `outward`')
      expect(note, type).toContain('negative -> `inward`')
    }
  })
})
