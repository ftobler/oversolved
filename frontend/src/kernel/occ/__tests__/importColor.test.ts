import { describe, it, expect } from 'vitest'
import { bodyImportColor, hexOfPackedRgb, hexOfUnitRgb, importColorNoteText } from '../importColor'

const RED = '#cc3333'
const BLUE = '#3333cc'
const GREEN = '#33cc33'

describe('bodyImportColor', () => {
  it('gives null when nothing is coloured', () => {
    expect(bodyImportColor([], null)).toBeNull()
    expect(bodyImportColor([{ color: null, area: 4 }, { color: null, area: 2 }], null)).toBeNull()
  })

  it('takes the one colour every face agrees on, with no note', () => {
    expect(bodyImportColor([{ color: RED, area: 1 }, { color: RED, area: 3 }], null))
      .toEqual({ color: RED, note: null })
  })

  it('falls back to the solid colour when the body has no faces to vote', () => {
    expect(bodyImportColor([], GREEN)).toEqual({ color: GREEN, note: null })
  })

  it('picks the majority by area, not by face count', () => {
    // Three small blue faces against one large red one: area wins.
    const result = bodyImportColor([
      { color: BLUE, area: 1 }, { color: BLUE, area: 1 }, { color: BLUE, area: 1 },
      { color: RED, area: 10 },
    ], null)
    expect(result?.color).toBe(RED)
    expect(result?.note?.share).toBeCloseTo(10 / 13, 12)
    expect(result?.note?.dropped).toEqual([BLUE])
  })

  it('lets uncoloured area outvote a lone coloured face', () => {
    // A logo face does not paint the body.
    expect(bodyImportColor([{ color: null, area: 9 }, { color: RED, area: 1 }], null)).toBeNull()
  })

  it('breaks a tie towards the solid colour', () => {
    const result = bodyImportColor([{ color: RED, area: 2 }, { color: BLUE, area: 2 }], BLUE)
    expect(result?.color).toBe(BLUE)
    expect(result?.note?.dropped).toEqual([RED])
  })

  it('breaks a tie towards the solid colour even when no face shows it', () => {
    const result = bodyImportColor([{ color: RED, area: 2 }, { color: BLUE, area: 2 }], GREEN)
    expect(result?.color).toBe(GREEN)
    expect(result?.note?.share).toBe(0)
    expect(result?.note?.dropped).toEqual([RED, BLUE])
  })

  it('breaks a tie without a solid colour towards the largest single face', () => {
    // Equal totals; blue owns the single biggest face.
    const result = bodyImportColor([
      { color: RED, area: 1 }, { color: RED, area: 1 }, { color: BLUE, area: 2 },
    ], null)
    expect(result?.color).toBe(BLUE)
  })

  it('treats areas within a relative 1e-9 as tied', () => {
    const result = bodyImportColor([{ color: RED, area: 1 }, { color: BLUE, area: 1 + 1e-12 }], RED)
    expect(result?.color).toBe(RED)
  })

  it('lists every dropped colour, largest area first', () => {
    const result = bodyImportColor([
      { color: RED, area: 10 }, { color: BLUE, area: 1 }, { color: GREEN, area: 3 }, { color: null, area: 2 },
    ], null)
    expect(result?.color).toBe(RED)
    expect(result?.note?.dropped).toEqual([GREEN, 'none', BLUE])
    expect(result?.note?.share).toBeCloseTo(10 / 16, 12)
  })

  it('ignores a non-finite or negative area', () => {
    const result = bodyImportColor([{ color: RED, area: Number.NaN }, { color: BLUE, area: -5 }, { color: RED, area: 1 }], null)
    expect(result?.color).toBe(RED)
  })
})

describe('colour encoding', () => {
  it('formats a packed value as lower-case #rrggbb', () => {
    expect(hexOfPackedRgb(0x808080)).toBe('#808080')
    expect(hexOfPackedRgb(0x0000ff)).toBe('#0000ff')
    expect(hexOfPackedRgb(0xCC3333)).toBe('#cc3333')
  })

  it('rounds unit channels to 8 bits, so near-equal colours vote together', () => {
    expect(hexOfUnitRgb(0.8, 0.2, 0.2)).toBe(hexOfUnitRgb(0.80001, 0.19999, 0.2))
    expect(hexOfUnitRgb(0.8, 0.2, 0.2)).toBe(RED)
    expect(hexOfUnitRgb(128 / 255, 128 / 255, 128 / 255)).toBe('#808080')
    expect(hexOfUnitRgb(1.2, -0.1, 0)).toBe('#ff0000')
  })
})

describe('importColorNoteText', () => {
  it('names the body, the colour, its share and the dropped colours', () => {
    expect(importColorNoteText('body_imp', { color: RED, share: 0.8571, dropped: [BLUE] }))
      .toBe('body body_imp takes #cc3333 from the STEP file (86% of its face area); 1 other colour dropped (#3333cc)')
    expect(importColorNoteText('b', { color: RED, share: 0.5, dropped: [BLUE, 'none'] }))
      .toContain('2 other colours dropped (#3333cc, none)')
  })
})
