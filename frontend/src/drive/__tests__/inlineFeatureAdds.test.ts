// @vitest-environment node
//
// The pure half of the bulk `add_chamfer` / `add_shell` forms: the catalog row
// and the shell sign note (thickness is a magnitude, `direction` carries the
// side, and CadQuery's signed thickness maps positive -> outward). The
// built-document half, where one call must produce the same solid as the old
// feature + pick + field sequence, is inlineFeatureAddsReal.test.ts.

import { describe, it, expect } from 'vitest'
import { mutationInfoOf } from '../mutationCatalog'

describe('add_revolve / add_sweep / add_transform / add_boolean inline payloads', () => {
  it('publishes the setter fields each add row now fronts', () => {
    const rows: Array<[Parameters<typeof mutationInfoOf>[0], readonly string[]]> = [
      ['add_revolve', ['direction', 'operation', 'merge_target']],
      ['add_sweep', ['transition', 'multisection', 'operation', 'merge_target']],
      ['add_transform', ['bodies', 'operation', 'translation', 'rotation_axis', 'rotation_angle', 'rotation_euler', 'scale']],
      ['add_boolean', ['keep_tools', 'clearance']],
    ]
    for (const [type, fields] of rows) {
      const info = mutationInfoOf(type)
      for (const field of fields) expect(info.fields[field], `${type}.${field}`).toBeDefined()
      expect(info.note ?? '', type).not.toContain('follow it with')
    }
  })
})

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
    expect(shell.fields.join).toBeDefined()
    expect(shell.note).toContain('faces')
    expect(shell.note).toContain('thickness')
    expect(shell.note).toContain('direction')
    expect(shell.note).toContain('join')
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
