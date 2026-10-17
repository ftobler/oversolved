// The helix editor schema, tested from its data alone (no viewport, per the
// frontend goal): which fields each mode shows and which picks are refused.

import { describe, it, expect } from 'vitest'
import { HELIX_SCHEMA } from '../featureEditorSchemas'
import type { PickFieldDef, SchemaData } from '../widgets/fieldTypes'

function field(key: string) {
  const f = HELIX_SCHEMA.fields.find((x) => x.key === key)
  if (!f) throw new Error(`no field ${key}`)
  return f
}

function shown(key: string, data: SchemaData): boolean {
  const f = field(key)
  return f.showWhen ? f.showWhen(data) : true
}

const base = { radius_mode: 'derived', reference: '@ex1/face/0:cylinderface' }

describe('HELIX_SCHEMA field visibility', () => {
  it('pitch_turns shows pitch and turns only', () => {
    const d = { ...base, mode: 'pitch_turns' }
    expect(shown('pitch', d)).toBe(true)
    expect(shown('turns', d)).toBe(true)
    expect(shown('height', d)).toBe(false)
    expect(shown('helix_angle', d)).toBe(false)
  })

  it('pitch_height shows pitch and height', () => {
    const d = { ...base, mode: 'pitch_height' }
    expect(shown('pitch', d)).toBe(true)
    expect(shown('turns', d)).toBe(false)
    expect(shown('height', d)).toBe(true)
    expect(shown('helix_angle', d)).toBe(false)
  })

  it('turns_height shows turns and height', () => {
    const d = { ...base, mode: 'turns_height' }
    expect(shown('pitch', d)).toBe(false)
    expect(shown('turns', d)).toBe(true)
    expect(shown('height', d)).toBe(true)
  })

  it('angle_turns shows helix_angle and turns', () => {
    const d = { ...base, mode: 'angle_turns' }
    expect(shown('helix_angle', d)).toBe(true)
    expect(shown('turns', d)).toBe(true)
    expect(shown('pitch', d)).toBe(false)
    expect(shown('height', d)).toBe(false)
  })

  it('angle_height shows helix_angle and height', () => {
    const d = { ...base, mode: 'angle_height' }
    expect(shown('helix_angle', d)).toBe(true)
    expect(shown('height', d)).toBe(true)
    expect(shown('turns', d)).toBe(false)
  })

  it('radius is shown only when entered', () => {
    expect(shown('radius', { ...base, radius_mode: 'derived' })).toBe(false)
    expect(shown('radius', { ...base, radius_mode: 'entered' })).toBe(true)
  })

  it('height_from_reference is shown for a height mode on a cylinder face', () => {
    expect(shown('height_from_reference', { mode: 'pitch_height', reference: '@ex1/face/0:cylinderface' })).toBe(true)
    expect(shown('height_from_reference', { mode: 'pitch_turns', reference: '@ex1/face/0:cylinderface' })).toBe(false)
    expect(shown('height_from_reference', { mode: 'pitch_height', reference: '?e:straightedge' })).toBe(false)
  })
})

describe('HELIX_SCHEMA reference pick', () => {
  const validate = (field('reference') as PickFieldDef).validatePick!
  it('accepts a cylinder face and circular/straight edges and sketch entities', () => {
    expect(validate('?...:cylinderface')).toBe(true)
    expect(validate('?...:straightedge')).toBe(true)
    expect(validate('?...:circle')).toBe(true)
    expect(validate('?...:arc')).toBe(true)
    expect(validate('entity:sk1:l1')).toBe(true)
    expect(validate('@ex1/face/0')).toBe(true)
  })
  it('refuses a flat face, a cone face and an ellipse', () => {
    expect(validate('?...:flatface')).toBe(false)
    expect(validate('?...:coneface')).toBe(false)
    expect(validate('?...:ellipse')).toBe(false)
  })
})
