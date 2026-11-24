// Selection-set references in a bug report description. A report can point at
// a named pick set without a second markup language, in one of two forms:
//
// - `#name` for a plain name (Unicode letters, marks and digits plus `_` and
//   `-`); CommonMark reads `#name` without a space as plain text, not a heading.
// - `#[any name]` for any other name. Inside the brackets `]` and `\` are
//   written escaped (`\]`, `\\`), so the token ends at the first unescaped `]`.
//
// A name is free text otherwise: the short form is kept for what it can carry,
// so an existing report and an existing habit keep working, and the bracketed
// form carries the rest. `referenceToken` is the one writer, used by the `#`
// button and by a rename, so both produce the same form for the same name.
//
// The functions are pure string transforms shared by the panel and the Markdown
// adapter: the panel warns about tokens no set names, and the downloaded report
// links the known ones to their sections. Both parse with the same token rule.

const NAME_CHARACTERS = String.raw`\p{L}\p{M}\p{N}_-`

// Only a name the short token can carry in full is written short; everything
// else needs the brackets, because a space or a `]` would end `#name` early.
const PLAIN_NAME_PATTERN = new RegExp(`^[${NAME_CHARACTERS}]+$`, 'u')

function escapeBracketName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
}

function unescapeBracketName(raw: string): string {
  return raw.replace(/\\(.)/g, '$1')
}

/** The reference token that names this set, in the form its name can carry. */
export function referenceToken(name: string): string {
  return PLAIN_NAME_PATTERN.test(name) ? `#${name}` : `#[${escapeBracketName(name)}]`
}

// A token starts at `#` and is either a bracketed name or a run of name
// characters. The lookbehind keeps a doubled `#` (a Markdown heading) and a `#`
// glued to a word from reading as a reference. The trailing boundary for the
// short form is the word-character class itself, so `#a` never matches the `#a`
// inside `#ab`; a bracketed token ends at its `]`. The hyphen is last in each
// class so it reads as a literal, not a range. An empty or unclosed bracket
// names nothing and so starts no token.
const REFERENCE_SOURCE = String.raw`(?<![\p{L}\p{M}\p{N}_#-])#(?:\[((?:\\.|[^\\\]])+)\]|([\p{L}\p{M}\p{N}_-]+))`

function referencePattern(): RegExp {
  return new RegExp(REFERENCE_SOURCE, 'gu')
}

// One parse for every consumer, so the panel's warning and the report's link
// can never disagree about what a token names.
function parsedName(bracketed: string | undefined, plain: string | undefined): string {
  return bracketed === undefined ? plain ?? '' : unescapeBracketName(bracketed)
}

/** Every reference token's name in the text, in the order it appears. */
export function findReferences(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(referencePattern())) {
    names.push(parsedName(match[1], match[2]))
  }
  return names
}

/** One `#token` that names no set, carrying the token as the user wrote it. */
export interface UnknownReference {
  token: string  // exactly as the user wrote it, escapes included
  name: string  // the set name it names
}

/** The tokens that name no set, without repeating a name the user typed twice. */
export function unknownReferences(text: string, setNames: readonly string[]): UnknownReference[] {
  const known = new Set(setNames)
  const seen = new Set<string>()
  const unknown: UnknownReference[] = []
  for (const match of text.matchAll(referencePattern())) {
    const name = parsedName(match[1], match[2])
    if (known.has(name) || seen.has(name)) continue
    seen.add(name)
    unknown.push({ token: match[0], name })
  }
  return unknown
}

/** Rewrite one whole-token reference, so a `#a` rename leaves `#ab` alone. */
export function renameReference(text: string, oldName: string, newName: string): string {
  if (!oldName || oldName === newName) return text
  return text.replace(referencePattern(), (token, bracketed?: string, plain?: string) =>
    parsedName(bracketed, plain) === oldName ? referenceToken(newName) : token,
  )
}

// The id half of an anchor, from the name alone: lowercase, Unicode letters,
// marks and digits kept, every other run collapsed to one `-`. The fallback
// keeps a name made only of punctuation from producing an empty id.
function selectionSetSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'set'
}

// Anchors are per section, in the caller's order. Names are unique in a draft,
// but two slugs can still collide (`Foo`/`foo`, or `_`/`-`), so a later section
// takes a numeric suffix. Aligning by index keeps duplicate names in an older
// report from sharing one heading.
export function selectionSetAnchors(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map(name => {
    const base = `selection-set-${selectionSetSlug(name)}`
    let anchor = base
    let suffix = 2
    while (used.has(anchor)) anchor = `${base}-${suffix++}`
    used.add(anchor)
    return anchor
  })
}

/** The anchor a single named selection-set section carries. */
export function selectionSetAnchor(name: string): string {
  return selectionSetAnchors([name])[0]
}

// Inside link text the token's own brackets must be escaped, or CommonMark ends
// the link at the first inner `]`. The text shown is the token as it reads, so
// a bracket-name's source escapes are dropped first: the backslash of `\]` is
// not part of the name, while a backslash in the name itself must be escaped
// again because it is the escape character of the text. The HTML characters are
// escaped too: a free-text name must not open a tag, a comment or an entity in
// the report a maintainer reads.
function escapeLinkText(token: string, name: string, bracketed: boolean): string {
  const shown = bracketed ? `#[${name}]` : token
  return shown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\[\]]/g, '\\$&')
}

/** Link every known reference to its set section; unknown tokens stay plain. */
export function linkReferences(text: string, setNames: readonly string[]): string {
  const anchors = selectionSetAnchors(setNames)
  const byName = new Map<string, string>()
  setNames.forEach((name, i) => {
    if (!byName.has(name)) byName.set(name, anchors[i])
  })
  return text.replace(referencePattern(), (token, bracketed?: string, plain?: string) => {
    const name = parsedName(bracketed, plain)
    const anchor = byName.get(name)
    return anchor ? `[${escapeLinkText(token, name, bracketed !== undefined)}](#${anchor})` : token
  })
}

// The token's own leading `#` is rejected by the parser when it is glued to a
// word character or to another `#`, so an insertion there adds one separating
// space. Without it, appending the `#` button's token to a description that
// ends in a word (`see here`) writes text that references nothing.
const TOKEN_BOUNDARY = /[\p{L}\p{M}\p{N}_#-]/u

// Inserting at the caret is a pure text edit plus the caret the textarea should
// restore after React re-renders; the panel only owns the element.
export function insertReference(
  text: string,
  name: string,
  start: number,
  end: number,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  const token = referenceToken(name)
  const before = from > 0 ? text[from - 1] : ''
  const after = to < text.length ? text[to] : ''
  const lead = before && TOKEN_BOUNDARY.test(before) ? ' ' : ''
  // The caret lands after the trailing space, so continued typing does not run
  // into the token that was just inserted.
  const trail = after && TOKEN_BOUNDARY.test(after) ? ' ' : ''
  return {
    text: text.slice(0, from) + lead + token + trail + text.slice(to),
    caret: from + lead.length + token.length + trail.length,
  }
}
