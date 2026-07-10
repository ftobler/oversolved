// Filename rules for the export dialog. Kept pure so they can be unit tested
// without mounting the dialog.

/**
 * Word separator to use when replacing spaces in a document name. A name that
 * already spells its own convention wins: dashes if it only uses dashes,
 * otherwise underscores (which also take precedence over a mixed name).
 */
function wordSeparator(docName: string): string {
  const hasDash = docName.includes('-')
  const hasUnderscore = docName.includes('_')
  if (hasDash && !hasUnderscore) return '-'
  return '_'
}

/** Turn a document name into the base of an export file name. */
export function sanitizeBaseName(docName: string): string {
  const trimmed = docName.trim()
  const base = trimmed.replace(/\s+/g, wordSeparator(trimmed))
  return base || 'export'
}

/** Replace the trailing extension of `name`, or append one if it has none. */
export function swapExtension(name: string, newExt: string): string {
  const lastDot = name.lastIndexOf('.')
  const base = lastDot > 0 ? name.slice(0, lastDot) : name
  return `${base}.${newExt}`
}

/**
 * Append the extension unless it is already there. Unlike `swapExtension` this
 * never rewrites a name, so a hand-typed `v1.2 bracket` keeps its dots.
 */
export function ensureExtension(name: string, ext: string): string {
  const trimmed = name.trim()
  if (!trimmed) return `export.${ext}`
  if (trimmed.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return trimmed
  return `${trimmed}.${ext}`
}

/** The name the dialog pre-fills when it opens on a document. */
export function defaultExportFileName(docName: string, ext: string): string {
  return `${sanitizeBaseName(docName)}.${ext}`
}
