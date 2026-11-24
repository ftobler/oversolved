// The names people read for the things a document holds: an entity, a
// constraint, a feature. A message names a thing by its kind and ordinal
// ("line 3", "coincident 4", "sketch 2") or by the user's own label
// ("sketch 'Base profile'"); the raw ids stay on the machine surfaces
// (structured reply fields, the bug report, logs).
//
// Pure and React-free, so the kernel, the drive boundary and the editor spell a
// name the same way. The ordinals are a reading aid, not identity: they shift
// when an earlier row of the same kind is deleted.

import { ENTITY_BY_KIND } from '@/registry/entityRegistry'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'

/** The minimum a naming helper reads off one row. `unknown` so a raw document
 *  record and a typed feature both pass. */
export interface NamingRow {
  id?: unknown
  kind?: unknown
  label?: unknown
}

/** What the naming helpers need from a sketch row: its label (the tree name),
 *  and its entity and constraint lists. */
export interface SketchNamingSource {
  id?: unknown
  label?: unknown
  entities?: unknown
  constraints?: unknown
}

function rowsOf(value: unknown): NamingRow[] {
  return Array.isArray(value) ? value as NamingRow[] : []
}

/** The document's feature rows in document order from the kernel's id-keyed
 *  map, with the key filled in as the id when a bare row omits it. One helper so
 *  every leaf builds the same ordered list for an ordinal. */
export function featureRows(featuresById: Readonly<Record<string, NamingRow>>): NamingRow[] {
  return Object.entries(featuresById).map(([id, row]) => ({ id, ...row }))
}

/** The word the user reads for an entity kind, from the entity registry:
 *  "line", "arc", "bezier". Null for a kind the app does not have, so a caller
 *  falls back instead of printing the raw kind string. */
export function entityKindWord(kind: string): string | null {
  return ENTITY_BY_KIND.get(kind)?.label.toLowerCase() ?? null
}

/** A kind word with its indefinite article, `a line` / `an arc`. Null for an
 *  unknown kind. */
export function entityKindPhrase(kind: string): string | null {
  const word = entityKindWord(kind)
  if (word === null) return null
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`
}

/**
 * One entity's name as the user reads it: `line 12`, its 1-based ordinal among
 * the sketch's entities OF THAT KIND in document order. The ordinal is per
 * kind, so adding a circle never renumbers the lines. A projected entity keeps
 * its base kind and takes a number in that kind's sequence (a projection is not
 * a distinct kind the user can see in the sketch; the tree draws it like any
 * other line). Null when the id is not in the sketch (a dangling ref) or its
 * kind is unknown; callers then say "the picked entity" rather than fall back
 * to the id, which the user cannot read.
 */
export function entityDisplayName(sketch: SketchNamingSource | undefined, eid: string): string | null {
  if (sketch === undefined) return null
  const entities = rowsOf(sketch.entities)
  const at = entities.findIndex((entity) => entity.id === eid)
  if (at < 0) return null
  const kind = entities[at].kind
  if (typeof kind !== 'string') return null
  const word = entityKindWord(kind)
  if (word === null) return null
  let ordinal = 0
  for (let i = 0; i <= at; i++) if (entities[i].kind === kind) ordinal++
  return `${word} ${ordinal}`
}

/**
 * One constraint's name as the user reads it: `coincident 4`, its 1-based
 * ordinal among the sketch's constraints OF THAT KIND in document order. Null
 * when the id is not in the authored list or its kind has no registry label.
 */
export function constraintDisplayName(sketch: SketchNamingSource | undefined, cid: string): string | null {
  if (sketch === undefined) return null
  const constraints = rowsOf(sketch.constraints)
  const at = constraints.findIndex((constraint) => constraint.id === cid)
  if (at < 0) return null
  const kind = constraints[at].kind
  if (typeof kind !== 'string') return null
  const word = CONSTRAINT_BY_KIND.get(kind)?.label.toLowerCase()
  if (word === undefined) return null
  let ordinal = 0
  for (let i = 0; i <= at; i++) if (constraints[i].kind === kind) ordinal++
  return `${word} ${ordinal}`
}

/** Kind words whose stored spelling differs from the words the UI uses. */
const FEATURE_KIND_WORDS: Readonly<Record<string, string>> = {
  // The UI says part; "body" is the stored key, never the word a person reads.
  delete_body: 'delete part',
}

/** The word a user reads for a feature kind, `linear pattern` / `sketch`. */
export function featureKindWord(kind: string): string {
  return FEATURE_KIND_WORDS[kind] ?? kind.replace(/_/g, ' ')
}

/** The word for a 1-based position in a list: `first`, `second`, ... `tenth`,
 *  then the number. Multi-target refusals use it to say which pick failed
 *  without printing the pick's id. */
const POSITION_WORDS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
] as const

export function positionWord(index: number): string {
  return POSITION_WORDS[index] ?? String(index + 1)
}

/** Normalise a label or kind spelling for the default-label comparison:
 *  underscores and runs of spaces both read as one space, case-insensitive. */
function normaliseKindText(text: string): string {
  return text.trim().replace(/_/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

/** The add commands' default label for a kind: the kind word, title-cased
 *  (`Move Face`, `Linear Pattern`, `Sweep`). */
function defaultKindLabel(word: string): string {
  return word.replace(/(^|\s)\S/g, (match) => match.toUpperCase())
}

/** Default labels that differ from the kind word (`Pattern` for the three
 *  pattern kinds). */
const DEFAULT_LABEL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  linear_pattern: ['Pattern'],
  circular_pattern: ['Pattern'],
  curve_pattern: ['Pattern'],
}

/**
 * Whether a label merely repeats the kind (an add command's default label:
 * `Sweep` on a sweep, `Move Face` on a move_face, `linear_pattern 1` on a linear
 * pattern). Such a label says nothing the kind ordinal does not, and its baked
 * number can be stale, so the display name falls back to the ordinal instead.
 *
 * The comparison normalises `_` to a space, so the raw spelling counts too. A
 * deliberate label survives: the capitalised default is matched exactly, but
 * `SKETCH` (different case) and a user-typed `Sweep 7` (the default has no
 * number) are not the default shape.
 */
function repeatsKindWord(kind: string, label: string, word: string): boolean {
  const match = /^(.+?)(?:\s+(\d+))?$/.exec(label.trim())
  if (match === null) return false
  const [, labelKind, ordinal] = match
  if (normaliseKindText(labelKind) !== normaliseKindText(word)) return false
  if (ordinal !== undefined) {
    // Generated `kind N` labels are written in the raw (lowercase/snake)
    // spelling; a capitalised `Sweep 7` is the author's own label.
    return labelKind === labelKind.toLowerCase()
  }
  const defaults = [defaultKindLabel(word), word, ...(DEFAULT_LABEL_ALIASES[kind] ?? [])]
  return defaults.includes(label)
}

/**
 * One feature's name as the user reads it: its `label` when the author set one
 * (`sketch 'Base profile'`), otherwise its kind and its 1-based ordinal among
 * the features OF THAT KIND in document order (`sketch 2`). Never the id. A
 * label that only repeats the kind word falls back to the ordinal.
 *
 * `features` is the document's ordered feature list, which gives the ordinal;
 * without it the name is `the sketch` (a caller holding only one row still
 * gets a sentence without an id).
 */
export function featureDisplayName(
  feature: NamingRow | undefined,
  features: readonly NamingRow[] = [],
): string {
  const id = typeof feature?.id === 'string' ? feature.id : ''
  const row = features.find((candidate) => id !== '' && candidate.id === id) ?? feature
  // A caller that names the kind (sketchDisplayName) wins over a bare test row
  // that carries only its entities.
  const rowKind = typeof row?.kind === 'string' && row.kind !== '' ? row.kind : undefined
  const featureKind = typeof feature?.kind === 'string' && feature.kind !== '' ? feature.kind : undefined
  const kind = rowKind ?? featureKind ?? 'feature'
  const word = featureKindWord(kind)
  const label = typeof row?.label === 'string' ? row.label.trim() : ''
  if (label !== '' && !repeatsKindWord(kind, label, word)) return `${word} '${label}'`
  let ordinal = 0
  for (const candidate of features) {
    if (candidate.kind !== kind) continue
    ordinal++
    if (candidate.id === id) return `${word} ${ordinal}`
  }
  return `the ${word}`
}

/**
 * A sketch named from the document's ordered feature rows when the caller has
 * only its id: `sketch 'Base profile'` / `sketch 2` / `the sketch` when the rows
 * are not in hand. The message callers use this for a subject inside a longer
 * sentence.
 */
export function sketchDisplayName(
  sketchId: string,
  features: readonly NamingRow[] = [],
): string {
  // A bare fixture row may carry only its entities; the caller naming a sketch
  // is the one that knows the kind.
  const rows = features.map((row) => (row.id === sketchId ? { ...row, kind: 'sketch' } : row))
  return featureDisplayName({ id: sketchId, kind: 'sketch' }, rows)
}
