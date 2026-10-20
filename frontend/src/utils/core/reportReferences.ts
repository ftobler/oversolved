// Selection-set references in a bug report description. The token is `#name`
// (CommonMark reads `#name` without a space as plain text, not a heading), so a
// report can point at a named pick set without a second markup language.
//
// The functions are pure string transforms shared by the panel and the Markdown
// adapter: the panel warns about tokens no set names, and the downloaded report
// links the known ones to their sections. Both use the same token rule.

export const SET_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

// A token starts at `#` and runs over name characters. The lookbehind keeps a
// doubled `#` (a Markdown heading) and a `#` glued to a word from reading as a
// reference. The trailing boundary is enforced by the callers that match one
// known name, so `#a` never rewrites the `#a` inside `#ab`.
const REFERENCE_SOURCE = String.raw`(?<![A-Za-z0-9_#-])#([A-Za-z0-9_-]+)`

function referencePattern(): RegExp {
  return new RegExp(REFERENCE_SOURCE, 'g')
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
    String.raw`(?<![A-Za-z0-9_#-])#${escapeName(oldName)}(?![A-Za-z0-9_-])`,
    'g',
  )
  return text.replace(pattern, `#${newName}`)
}

/** The anchor a rendered selection-set section carries. */
export function selectionSetAnchor(name: string): string {
  return `selection-set-${name}`
}

/** Link every known `#name` to its set section; unknown tokens stay plain. */
export function linkReferences(text: string, setNames: readonly string[]): string {
  const known = new Set(setNames)
  return text.replace(referencePattern(), (token, name: string) =>
    known.has(name) ? `[${token}](#${selectionSetAnchor(name)})` : token,
  )
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
