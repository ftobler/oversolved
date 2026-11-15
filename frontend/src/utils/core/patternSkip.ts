// Skip Instances: the page-selector text every pattern kind shares. One entry
// is a 1D instance index or a `column:row` grid cell; a bare integer means
// `i:0`, so a list typed for a 1D pattern stays meaningful when a second
// direction is turned on. Integers only: a `-` is the sign of a reverse-side
// index, so `3-5` is not a range and is refused by name.

/** One skipped instance: a signed 1D index, or a `[column, row]` grid cell. */
export type SkipEntry = number | readonly [number, number]

export interface SkipParse {
  ok: true
  skip: SkipEntry[]
}
export interface SkipParseError {
  ok: false
  error: string
}

const TOKEN = /^(-?\d+)(?::(-?\d+))?$/

/** The stable spelling of one entry, the same string the kernel keys an
 *  instance by: `3`, `-1`, `2:-1`. */
export function skipEntryKey(entry: SkipEntry): string {
  return typeof entry === 'number' ? String(entry) : `${entry[0]}:${entry[1]}`
}

function asPair(entry: SkipEntry): [number, number] {
  return typeof entry === 'number' ? [entry, 0] : [entry[0], entry[1]]
}

/** Sort ascending (column first, then row) and drop duplicates. A pair whose
 *  row is 0 collapses to the bare 1D spelling, so `1` and `1:0` are one entry. */
export function canonicalSkip(skip: readonly SkipEntry[]): SkipEntry[] {
  const byKey = new Map<string, SkipEntry>()
  for (const entry of skip) {
    const [i, j] = asPair(entry)
    const canonical: SkipEntry = j === 0 ? i : [i, j]
    byKey.set(skipEntryKey(canonical), canonical)
  }
  return [...byKey.values()].sort((a, b) => {
    const [ai, aj] = asPair(a)
    const [bi, bj] = asPair(b)
    return ai - bi || aj - bj
  })
}

/** The field text an author sees: `1, 2, 6, 7`, or `2:-1` for a grid cell. */
export function formatSkipList(skip: readonly SkipEntry[] | undefined | null): string {
  return canonicalSkip(skip ?? []).map(skipEntryKey).join(', ')
}

/**
 * Parse the Skip Instances text. An empty string is the empty list. Every
 * refusal names the token, because the fix is almost always the spelling of
 * one entry rather than the list as a whole.
 */
export function parseSkipList(text: string): SkipParse | SkipParseError {
  const tokens = text.trim() === '' ? [] : text.trim().split(/[\s,]+/)
  const entries: SkipEntry[] = []
  for (const token of tokens) {
    if (token === '') continue
    const match = TOKEN.exec(token)
    if (match === null) {
      if (/\d\s*-\s*\d/.test(token)) {
        return { ok: false, error: `"${token}" is not an instance number; ranges are not supported, list each instance (for example 3, 4, 5)` }
      }
      if (token.endsWith(':')) {
        return { ok: false, error: `"${token}" is not a cell; write column:row, for example 2:-1` }
      }
      if (/^-?\d+\.\d+$/.test(token)) {
        return { ok: false, error: `"${token}" is not a whole instance number; use integers only` }
      }
      return { ok: false, error: `"${token}" is not an instance number; use integers such as 1, 2, -1` }
    }
    const i = Number(match[1])
    const j = match[2] === undefined ? 0 : Number(match[2])
    if (i === 0 && j === 0) {
      return { ok: false, error: 'instance 0 is the original and cannot be skipped' }
    }
    entries.push(j === 0 ? i : [i, j])
  }
  return { ok: true, skip: canonicalSkip(entries) }
}

/**
 * The refusal one stored skip list earns, or null. The loader, the drive and
 * the kernel all decide through this, so a list one path accepts never fails
 * another. Entries are integers; 0 is the original and cannot be skipped, and
 * neither can the grid's seed cell (0,0).
 */
export function skipProblem(skip: unknown): string | null {
  if (!Array.isArray(skip)) return `skip must be a list of instance numbers, got ${JSON.stringify(skip)}`
  for (let index = 0; index < skip.length; index++) {
    const entry: unknown = skip[index]
    const at = `skip[${index}]`
    if (typeof entry === 'number') {
      if (!Number.isInteger(entry)) return `${at} must be a whole instance number, got ${JSON.stringify(entry)}`
      if (entry === 0) return 'instance 0 is the original and cannot be skipped'
      continue
    }
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every((part) => typeof part === 'number' && Number.isInteger(part))) {
      return `${at} must be an integer or a [column, row] pair of integers, got ${JSON.stringify(entry)}`
    }
    if (entry[0] === 0 && entry[1] === 0) return 'instance 0:0 is the original and cannot be skipped'
  }
  return null
}

/**
 * A mutation value in either accepted spelling: the stored list, or the editor
 * text parsed the way the field parses it. A parser refusal is the sentence the
 * caller shows, so the drive and the editor refuse one input with one reason.
 */
export function skipValue(value: unknown): { skip: SkipEntry[] } | { error: string } {
  if (typeof value === 'string') {
    const parsed = parseSkipList(value)
    return parsed.ok ? { skip: parsed.skip } : { error: parsed.error }
  }
  const problem = skipProblem(value)
  if (problem !== null) return { error: problem }
  return { skip: canonicalSkip(value as SkipEntry[]) }
}
