// The one list of feature kinds a feature pattern or a feature mirror repeats.
// The kernel's tool table and the editor's pick chip read it, so admitting a
// kind is one edit here plus its leaf's tool build. The drive's catalog notes
// cannot import it into their prose, so `catalogNotes.test.ts` pins that every
// source note names the same rule. It imports nothing, so an editor module can
// read it without pulling OCC into the UI bundle.
//
// A hole is on the list because it hands back the per-site cutter it actually
// cut with; it has no `operation` of its own, so its only meaning is a cut.

export const PATTERN_SOURCE_KINDS = ['extrude', 'revolve', 'sweep', 'wrap', 'hole'] as const

export type PatternSourceKind = (typeof PATTERN_SOURCE_KINDS)[number]

/** The kinds as a sentence fragment the editor and the drive notes share. */
export const PATTERN_SOURCE_KIND_LIST = 'an extrude, revolve, sweep, wrap or hole'

export function isPatternSourceKind(kind: string): kind is PatternSourceKind {
  return (PATTERN_SOURCE_KINDS as readonly string[]).includes(kind)
}

/** What a source has to be, in the caller's own words. The pattern's sentence
 *  predates the shared engine and is pinned by its tests, so it stays literal;
 *  a mirror reads the same rule with its own name. */
export function patternSourceKindSentence(noun: string): string {
  return noun === 'pattern'
    ? `a feature pattern repeats ${PATTERN_SOURCE_KIND_LIST}`
    : `a ${noun} source repeats ${PATTERN_SOURCE_KIND_LIST}`
}
