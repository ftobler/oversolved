// Selection-set references in a bug report description. The token is `#name`
// (CommonMark reads `#name` without a space as plain text, not a heading), so a
// report can point at a named pick set without a second markup language.
//
// The functions are pure string transforms shared by the panel and the Markdown
// adapter: the panel warns about tokens no set names, and the downloaded report
// links the known ones to their sections. Both use the same token rule.
//
// A name is any run of Unicode letters, marks and digits plus `_` and `-`; a
// space would end the `#name` token, so the rule keeps the token unambiguous.

const NAME_CHARACTERS = String.raw`\p{L}\p{M}\p{N}_-`

export const SET_NAME_PATTERN = new RegExp(`^[${NAME_CHARACTERS}]+$`, 'u')

// A token starts at `#` and runs over name characters. The lookbehind keeps a
// doubled `#` (a Markdown heading) and a `#` glued to a word from reading as a
// reference. The trailing boundary is enforced by the callers that match one
// known name, so `#a` never rewrites the `#a` inside `#ab`. The hyphen is last
// in each class so it reads as a literal, not a range.
const REFERENCE_SOURCE = String.raw`(?<![\p{L}\p{M}\p{N}_#-])#([\p{L}\p{M}\p{N}_-]+)`

function referencePattern(): RegExp {
  return new RegExp(REFERENCE_SOURCE, 'gu')
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every `#name` token in the text, in the order it appears. */
function findReferences(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(referencePattern())) {
    names.push(match[1])
  }
  return names
}

/** The tokens that name no set, without repeating a token the user typed twice. */
export function unknownReferences(text: string, setNames: readonly string[]): string[] {
  const known = new Set(setNames)
  return [...new Set(findReferences(text).filter(name => !known.has(name)))]
}

/** Rewrite one whole-token reference, so a `#a` rename leaves `#ab` alone. */
export function renameReference(text: string, oldName: string, newName: string): string {
  if (!oldName || oldName === newName) return text
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{M}\p{N}_#-])#${escapeName(oldName)}(?![${NAME_CHARACTERS}])`,
    'gu',
  )
  return text.replace(pattern, `#${newName}`)
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

/** Link every known `#name` to its set section; unknown tokens stay plain. */
export function linkReferences(text: string, setNames: readonly string[]): string {
  const anchors = selectionSetAnchors(setNames)
  const byName = new Map<string, string>()
  setNames.forEach((name, i) => {
    if (!byName.has(name)) byName.set(name, anchors[i])
  })
  return text.replace(referencePattern(), (token, name: string) => {
    const anchor = byName.get(name)
    return anchor ? `[${token}](#${anchor})` : token
  })
}

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
  const token = `#${name}`
  return {
    text: text.slice(0, from) + token + text.slice(to),
    caret: from + token.length,
  }
}
