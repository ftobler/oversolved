// The standard thread table: the designations a hole's cosmetic thread can be
// picked from, with the nominal diameter, pitch and tap drill each carries.
//
// The table is pure data, shared by the editor (the select's options), the doc
// schema (the cross-check on a loaded thread spec) and the kernel (the metadata
// a solve reports). A cosmetic thread changes no geometry: the hole keeps the
// bore the user authored, and the table only says what thread the bore is for.
//
// Tap drills are the published values for the coarse series (nominal minus
// pitch for the metric sizes; the standard inch drills, e.g. #7 for 1/4-20 and
// #3 for 1/4-28, converted to millimetres for the unified ones), not a formula:
// the standard is the data, and the table's own test pins the published drill of
// a representative row per series as well as the invariant that a tap drill is
// smaller than its nominal.

export type ThreadSystem = 'metric' | 'unc' | 'unf'

export interface ThreadEntry {
  designation: string
  system: ThreadSystem
  // The thread's own (major) diameter in millimetres.
  nominal: number
  pitch: number
  // The drill that prepares the hole for this thread.
  tapDrill: number
}

export const THREAD_TABLE: readonly ThreadEntry[] = [
  { designation: 'M2x0.4', system: 'metric', nominal: 2, pitch: 0.4, tapDrill: 1.6 },
  { designation: 'M2.5x0.45', system: 'metric', nominal: 2.5, pitch: 0.45, tapDrill: 2.05 },
  { designation: 'M3x0.5', system: 'metric', nominal: 3, pitch: 0.5, tapDrill: 2.5 },
  { designation: 'M4x0.7', system: 'metric', nominal: 4, pitch: 0.7, tapDrill: 3.3 },
  { designation: 'M5x0.8', system: 'metric', nominal: 5, pitch: 0.8, tapDrill: 4.2 },
  { designation: 'M6x1', system: 'metric', nominal: 6, pitch: 1, tapDrill: 5 },
  { designation: 'M8x1.25', system: 'metric', nominal: 8, pitch: 1.25, tapDrill: 6.8 },
  { designation: 'M10x1.5', system: 'metric', nominal: 10, pitch: 1.5, tapDrill: 8.5 },
  { designation: 'M12x1.75', system: 'metric', nominal: 12, pitch: 1.75, tapDrill: 10.2 },
  { designation: '1/4-20 UNC', system: 'unc', nominal: 6.35, pitch: 1.27, tapDrill: 5.1054 },
  { designation: '5/16-18 UNC', system: 'unc', nominal: 7.9375, pitch: 1.4111, tapDrill: 6.5278 },
  { designation: '3/8-16 UNC', system: 'unc', nominal: 9.525, pitch: 1.5875, tapDrill: 7.9375 },
  { designation: '1/4-28 UNF', system: 'unf', nominal: 6.35, pitch: 0.9071, tapDrill: 5.4102 },
  { designation: '5/16-24 UNF', system: 'unf', nominal: 7.9375, pitch: 1.0583, tapDrill: 6.9088 },
  { designation: '3/8-24 UNF', system: 'unf', nominal: 9.525, pitch: 1.0583, tapDrill: 8.4328 },
]

const BY_DESIGNATION = new Map(THREAD_TABLE.map((entry) => [entry.designation, entry]))

/** The table entry a designation names, or null for an unknown one. */
export function threadEntry(designation: string): ThreadEntry | null {
  return BY_DESIGNATION.get(designation) ?? null
}

/** The designations the editor offers, in table order. */
export function threadDesignations(): string[] {
  return THREAD_TABLE.map((entry) => entry.designation)
}

/** The option label: designation, pitch and the drill the hole should carry. */
export function threadLabel(entry: ThreadEntry): string {
  return `${entry.designation} (drill ${entry.tapDrill})`
}
