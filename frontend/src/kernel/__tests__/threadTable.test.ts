// The thread table's own contract: designations are unique and parse into the
// nominal x pitch they claim, every entry's tap drill can actually prepare its
// thread, and the inch sizes are the standard ones (not the metric series
// relabelled).
import { describe, it, expect } from 'vitest'
import { THREAD_TABLE, threadDesignations, threadEntry, threadLabel } from '../threadTable'

describe('the thread table', () => {
  it('keys every entry by a unique designation', () => {
    const names = THREAD_TABLE.map((e) => e.designation)
    expect(new Set(names).size).toBe(names.length)
    expect(threadDesignations()).toEqual(names)
  })

  it('gives every entry a positive nominal, pitch and tap drill below the nominal', () => {
    for (const entry of THREAD_TABLE) {
      expect(entry.nominal, entry.designation).toBeGreaterThan(0)
      expect(entry.pitch, entry.designation).toBeGreaterThan(0)
      expect(entry.tapDrill, entry.designation).toBeGreaterThan(0)
      // The thread's flanks need room: a tap drill at or above the nominal
      // cannot cut a matching thread.
      expect(entry.tapDrill, entry.designation).toBeLessThan(entry.nominal)
    }
  })

  // The published drill for one representative row per series, so a row edited
  // to a plausible-looking but wrong number cannot pass on the inequality above.
  // Metric values are the standard nominal-minus-pitch drills; the unified ones
  // are the standard inch drills (1/4-20 #7, 1/4-28 #3, 5/16-18 F, 5/16-24 I,
  // 3/8-16 5/16in, 3/8-24 Q) converted to millimetres.
  const PUBLISHED_DRILLS: Record<string, number> = {
    'M2x0.4': 1.6,
    'M3x0.5': 2.5,
    'M6x1': 5,
    'M8x1.25': 6.8,
    'M12x1.75': 10.2,
    '1/4-20 UNC': 5.1054,
    '1/4-28 UNF': 5.4102,
    '5/16-18 UNC': 6.5278,
    '5/16-24 UNF': 6.9088,
    '3/8-16 UNC': 7.9375,
    '3/8-24 UNF': 8.4328,
  }

  it('pins the published tap drill of a representative row per series', () => {
    for (const [designation, drill] of Object.entries(PUBLISHED_DRILLS)) {
      const entry = threadEntry(designation)
      expect(entry, designation).not.toBeNull()
      expect(entry!.tapDrill, designation).toBeCloseTo(drill, 4)
    }
    // The map is a representative sample, not the whole table: a row missing
    // from it would otherwise be a silently untested entry.
    expect(Object.keys(PUBLISHED_DRILLS).length).toBeGreaterThanOrEqual(THREAD_TABLE.length - 4)
  })

  it('declares the metric designations as nominal x pitch', () => {
    for (const entry of THREAD_TABLE.filter((e) => e.system === 'metric')) {
      const [nominal, pitch] = entry.designation.slice(1).split('x').map(Number)
      expect(nominal, entry.designation).toBeCloseTo(entry.nominal, 9)
      expect(pitch, entry.designation).toBeCloseTo(entry.pitch, 9)
    }
  })

  it('declares the unified designations as major diameter - threads per inch', () => {
    for (const entry of THREAD_TABLE.filter((e) => e.system !== 'metric')) {
      const match = /^(\d+)\/(\d+)-(\d+) (UNC|UNF)$/.exec(entry.designation)
      expect(match, entry.designation).not.toBeNull()
      const majorInch = Number(match![1]) / Number(match![2])
      expect(majorInch * 25.4, entry.designation).toBeCloseTo(entry.nominal, 3)
      expect(25.4 / Number(match![3]), entry.designation).toBeCloseTo(entry.pitch, 3)
      expect(entry.system, entry.designation).toBe(match![4].toLowerCase())
    }
  })

  it('looks entries up by designation and labels them with the drill', () => {
    const m6 = threadEntry('M6x1')
    expect(m6).not.toBeNull()
    expect(m6!.nominal).toBe(6)
    expect(m6!.pitch).toBe(1)
    expect(threadLabel(m6!)).toBe('M6x1 (drill 5)')
    expect(threadEntry('M7x1')).toBeNull()
  })
})
