// Joint limits at the document boundary: the v5 rotating-limit normalization,
// the range validation, and the "absent means open" contract.
import { describe, it, expect } from 'vitest'
import {
  CURRENT_DOC_VERSION,
  loadAssemblyDocText,
  migrate,
} from '@/persistence/docSchema'

function assembly(mate: string, version = CURRENT_DOC_VERSION): string {
  return `version: ${version}
kind: assembly
features:
  - id: m1
    kind: mate
    mate:
      kind: rotating
      ref_a: { part: a, anchor: x }
      ref_b: { part: b, anchor: y }
${mate}
`
}

function loaded(text: string) {
  const result = loadAssemblyDocText(text)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`${result.error.field}: ${result.error.message}`)
  return result
}

describe('mate joint limits in the document', () => {
  it('keeps an authored rotating range on the solver\'s signed coordinate', () => {
    const result = loaded(assembly('      limit_min: -45\n      limit_max: 45'))
    const mate = (result.doc.features ?? [])[0].mate!
    expect(mate.limit_min).toBe(-45)
    expect(mate.limit_max).toBe(45)
    expect(result.migrations).toEqual([])
  })

  it('leaves an absent bound absent, never a stop at zero', () => {
    const result = loaded(assembly('      limit_max: 30'))
    const mate = (result.doc.features ?? [])[0].mate!
    expect(mate.limit_max).toBe(30)
    expect(mate.limit_min).toBeUndefined()
  })

  it('folds a pre-v5 rotating bound into (-180, 180] once', () => {
    // A hand-authored or pre-v5 document can spell 270; the solver's roll
    // coordinate is signed, and the ladder heals it before validation.
    const result = loaded(assembly('      limit_min: 270\n      limit_max: 350', 4))
    const mate = (result.doc.features ?? [])[0].mate!
    expect(mate.limit_min).toBe(-90)
    expect(mate.limit_max).toBe(-10)
    expect(result.migrations).toContain('mate-limit-degrees')
  })

  it('is idempotent: a second load finds nothing to rewrite', () => {
    const doc = { version: 4, kind: 'assembly', features: [{ id: 'm1', kind: 'mate', mate: { kind: 'rotating', limit_min: 270, limit_max: 350 } }] }
    expect(migrate(doc, 4)).toContain('mate-limit-degrees')
    expect(migrate(doc, 4)).toEqual([])
  })

  it('does not fold a lone out-of-range bound into a different constraint', () => {
    // 181 allows every reachable roll; -179 would pin it to a one-degree arc.
    // A pair is needed before folding can preserve the authored interval.
    const doc = { version: 4, kind: 'assembly', features: [{ id: 'm1', kind: 'mate', mate: { kind: 'rotating', limit_max: 181 } }] }
    expect(migrate(doc, 4)).toEqual([])
    expect((doc.features[0].mate as { limit_max?: number }).limit_max).toBe(181)
  })

  it('does not fold a pair that spans a full turn or more', () => {
    // A 360 degree span is the whole circle, not a signed interval; folding
    // [-180, 180] to a pin at 180 would invent the narrowest possible range.
    for (const [min, max] of [[-180, 180], [-90, 300]] as const) {
      const doc = { version: 4, kind: 'assembly', features: [{ id: 'm1', kind: 'mate', mate: { kind: 'rotating', limit_min: min, limit_max: max } }] }
      expect(migrate(doc, 4)).toEqual([])
      expect(doc.features[0].mate).toMatchObject({ limit_min: min, limit_max: max })
    }
  })

  it('refuses a rotating bound outside the representable half turn', () => {
    const result = loadAssemblyDocText(assembly('      limit_min: 270'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toContain('limit_min')
    expect(result.error.message).toContain('(-180, 180]')
  })

  it('refuses an inverted range', () => {
    const result = loadAssemblyDocText(assembly('      limit_min: 30\n      limit_max: 10'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toContain('limit_max')
    expect(result.error.message).toContain('at least limit_min 30')
  })

  it('refuses a rotating range that crosses the +/-180 cut', () => {
    // 170..190 is 20 degrees wide but folds to 170..-170, which no single
    // signed interval can name. The message points at the representable range.
    const result = loadAssemblyDocText(assembly('      limit_min: 170\n      limit_max: 190', 4))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toContain('limit_max')
    expect(result.error.message).toContain('(-180, 180]')
  })

  it('accepts a sliding range in millimetres', () => {
    const text = `version: ${CURRENT_DOC_VERSION}
kind: assembly
features:
  - id: m1
    kind: mate
    mate:
      kind: sliding
      ref_a: { part: a, anchor: x }
      ref_b: { part: b, anchor: y }
      limit_min: 0
      limit_max: 50
`
    const result = loaded(text)
    const mate = (result.doc.features ?? [])[0].mate!
    expect([mate.limit_min, mate.limit_max]).toEqual([0, 50])
  })

  it('leaves a document without limits free to move', () => {
    const text = `version: ${CURRENT_DOC_VERSION}
kind: assembly
features:
  - id: m1
    kind: mate
    mate:
      kind: sliding
      ref_a: { part: a, anchor: x }
      ref_b: { part: b, anchor: y }
`
    const result = loaded(text)
    const mate = (result.doc.features ?? [])[0].mate!
    expect(mate.limit_min).toBeUndefined()
    expect(mate.limit_max).toBeUndefined()
  })
})
