import { describe, it, expect } from 'vitest'
import { partImportColor, hexOfPackedRgb, importColorNoteText, UNCOLOURED } from '../importColor'

const RED = '#cc3333'
const BLUE = '#3333cc'
const GREEN = '#33cc33'

describe('partImportColor', () => {
  // Every case is one part (one solid) of an import.
  it('gives null when nothing is coloured', () => {
    expect(partImportColor([], null)).toBeNull()
    expect(partImportColor([{ color: null, area: 4 }, { color: null, area: 2 }], null)).toBeNull()
  })

  it('takes the one colour every face agrees on, with no note', () => {
    expect(partImportColor([{ color: RED, area: 1 }, { color: RED, area: 3 }], null))
      .toEqual({ color: RED, note: null })
  })

  it('falls back to the solid colour when the part has no faces to vote', () => {
    expect(partImportColor([], GREEN)).toEqual({ color: GREEN, note: null })
  })

  it('picks the majority by area, not by face count', () => {
    // Three small blue faces against one large red one: area wins.
    const result = partImportColor([
      { color: BLUE, area: 1 }, { color: BLUE, area: 1 }, { color: BLUE, area: 1 },
      { color: RED, area: 10 },
    ], null)
    expect(result?.color).toBe(RED)
    expect(result?.note?.choice).toBe('majority')
    expect(result?.note?.share).toBeCloseTo(10 / 13, 12)
    expect(result?.note?.dropped).toEqual([BLUE])
  })

  it('lets uncoloured area outvote a lone coloured face, and still says so', () => {
    // A logo face does not paint the part, but the faces disagreed.
    const result = partImportColor([{ color: null, area: 9 }, { color: RED, area: 1 }], null)
    expect(result?.color).toBeNull()
    expect(result?.note).toEqual({ color: null, share: 0.9, choice: 'majority', dropped: [RED] })
  })

  it('breaks a tie towards the solid colour', () => {
    const result = partImportColor([{ color: RED, area: 2 }, { color: BLUE, area: 2 }], BLUE)
    expect(result?.color).toBe(BLUE)
    expect(result?.note?.choice).toBe('solid-tie')
    expect(result?.note?.dropped).toEqual([RED])
  })

  it('breaks a tie towards the solid colour even when no face shows it', () => {
    const result = partImportColor([{ color: RED, area: 2 }, { color: BLUE, area: 2 }], GREEN)
    expect(result?.color).toBe(GREEN)
    expect(result?.note?.share).toBe(0)
    expect(result?.note?.dropped).toEqual([RED, BLUE])
  })

  it('breaks a tie without a solid colour towards the largest single face', () => {
    // Equal totals; blue owns the single biggest face.
    const result = partImportColor([
      { color: RED, area: 1 }, { color: RED, area: 1 }, { color: BLUE, area: 2 },
    ], null)
    expect(result?.color).toBe(BLUE)
    expect(result?.note?.choice).toBe('largest-face-tie')
  })

  it('treats areas within a relative 1e-9 as tied', () => {
    const result = partImportColor([{ color: RED, area: 1 }, { color: BLUE, area: 1 + 1e-12 }], RED)
    expect(result?.color).toBe(RED)
  })

  it('lists every dropped colour, largest area first, the uncoloured share by name', () => {
    const result = partImportColor([
      { color: RED, area: 10 }, { color: BLUE, area: 1 }, { color: GREEN, area: 3 }, { color: null, area: 2 },
    ], null)
    expect(result?.color).toBe(RED)
    expect(result?.note?.dropped).toEqual([GREEN, UNCOLOURED, BLUE])
    expect(result?.note?.share).toBeCloseTo(10 / 16, 12)
  })

  it('ignores a non-finite or negative area', () => {
    const result = partImportColor([{ color: RED, area: Number.NaN }, { color: BLUE, area: -5 }, { color: RED, area: 1 }], null)
    expect(result?.color).toBe(RED)
  })
})

describe('colour encoding', () => {
  it('formats a packed value as lower-case #rrggbb', () => {
    expect(hexOfPackedRgb(0x808080)).toBe('#808080')
    expect(hexOfPackedRgb(0x0000ff)).toBe('#0000ff')
    expect(hexOfPackedRgb(0xCC3333)).toBe('#cc3333')
  })
})

describe('importColorNoteText', () => {
  it('names the part, the colour, its share and the dropped colours', () => {
    expect(importColorNoteText('body_imp', { color: RED, share: 0.8571, choice: 'majority', dropped: [BLUE] }))
      .toBe('part body_imp takes #cc3333 from the STEP file (86% of its face area); 1 other colour dropped (#3333cc)')
    expect(importColorNoteText('b', { color: RED, share: 0.5, choice: 'majority', dropped: [BLUE, UNCOLOURED] }))
      .toContain('2 other colours dropped (#3333cc, uncoloured)')
  })

  it('says a solid colour settled a tie instead of quoting a 0% share', () => {
    const text = importColorNoteText('b', { color: GREEN, share: 0, choice: 'solid-tie', dropped: [RED, BLUE] })
    expect(text).toBe("part b takes #33cc33, the STEP file's colour for the solid, because its face colours tie; "
      + '2 other colours dropped (#cc3333, #3333cc)')
    expect(text).not.toContain('0%')
  })

  it('names a tie broken by the largest face', () => {
    expect(importColorNoteText('b', { color: BLUE, share: 0.5, choice: 'largest-face-tie', dropped: [RED] }))
      .toContain('(50% of its face area, a tie broken by its largest face)')
  })

  it('says when the part stays uncoloured', () => {
    expect(importColorNoteText('b', { color: null, share: 0.9, choice: 'majority', dropped: [RED] }))
      .toBe('part b stays uncoloured: 90% of its face area has no colour in the STEP file; 1 other colour dropped (#cc3333)')
  })
})
