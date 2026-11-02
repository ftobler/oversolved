/**
 * Shared scaffolding for the lint-shaped source scans in the guard tests:
 * the file walk, the test-file predicate, comment stripping so prose cannot
 * trip a scan, the import-specifier regexes, and the `@/`-alias resolution
 * the import-boundary guards need. `stripComments` blanks instead of
 * deletes: a scan that deletes comment matches shifts every later line and
 * merges the line before a `//` into the match, so a guard that prints
 * `file:line` would name the right file at the wrong line.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

const TS_EXTS = ['.ts', '.tsx']

/** Every file under `dir` whose extension is in `exts` (with its leading
 *  dot). Dirent entries keep a stray or broken symlink from throwing
 *  mid-walk; a symlinked directory under a scanned root is not followed. */
export function collectSourceFiles(dir: string, exts: string[] = TS_EXTS): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectSourceFiles(full, exts))
    else if (exts.includes(extname(entry.name))) files.push(full)
  }
  return files
}

/** The repo's test predicate: a `__tests__` directory file, or a
 *  `*.test.ts(x)` anywhere beside the module it drives. */
export function isTestFile(path: string): boolean {
  return path.includes('__tests__') || /\.test\.tsx?$/.test(path)
}

/** What Vite can bundle: the walk minus the test files. */
export function productionFiles(dir: string, exts: string[] = TS_EXTS): string[] {
  return collectSourceFiles(dir, exts).filter((f) => !isTestFile(f))
}

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /(?:^|\s)\/\/[^\n]*/g

/**
 * Blank out comments without moving text: matched bytes become spaces and
 * newlines survive, so line numbers and match offsets stay valid against
 * the real file. Deleting the matched comments instead, as the pre-helper
 * scans did, joins lines and desyncs every reported line number after any
 * comment; guards that print `file:line` for a reviewer depend on this.
 */
export function stripComments(text: string): string {
  return text
    .replace(BLOCK_COMMENT, (m) => m.replace(/[^\n]/g, ' '))
    .replace(LINE_COMMENT, (m) => m.replace(/[^\n]/g, ' '))
}

/** A file's live source: comments blanked, everything else byte-for-byte. */
export function liveText(file: string): string {
  return stripComments(readFileSync(file, 'utf8'))
}

// Static `from` clauses (import and re-export, type-only included),
// side-effect imports, and dynamic `import()`. The negated classes span
// newlines on purpose: a multi-line named-import list is one statement.
// Each entry is capture group 1. They carry /g: use them with matchAll or
// replace, not .test, whose lastIndex would leak between scans.
export const IMPORT_SPECIFIERS = [
  /(?:^|\n)\s*(?:import|export)\s[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/**
 * Resolve an `@/` alias or a relative specifier under `src` to an on-disk
 * source file, index files included. Vite loader hints (`?url` / `?worker`)
 * are cut before resolution, so they land on the real file; null covers
 * bare packages and misses. The alias and a relative hop must land on the
 * same target or a boundary scan only catches half of each edge.
 */
export function resolveSpecifier(src: string, fromFile: string, specifier: string): string | null {
  const clean = specifier.split('?')[0]
  const base = clean.startsWith('@/')
    ? join(src, clean.slice(2))
    : clean.startsWith('.')
      ? join(dirname(fromFile), clean)
      : null
  if (!base) return null
  const candidates = [base, base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}
