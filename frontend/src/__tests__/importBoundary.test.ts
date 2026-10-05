/**
 * Dependency-inversion guard for the review's architecture findings (A-3/A-4):
 * the CAD kernel and the pure utils leaves must not import from the UI tree
 * (`@/components/`) or the stores layer (`@/stores/`), and the picking core
 * must not import the stores layer either (A-4 moved its `failLoud` use).
 * Deleting the Viewport, or refactoring the stores, must not break the solver
 * path.
 *
 * Specifiers are resolved to files, so the `@/` alias, relative paths and
 * dynamic `import()` all get caught. A source-text scan (same shape as
 * utils/__tests__/codeConventions.test.ts): fast, deterministic, needs no
 * module graph, and catches type-only imports too, which vanish from the
 * bundle but still couple the layers at compile time. Test files are skipped:
 * the rule is about what ships.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, extname, join, sep } from 'path'

const SRC = join(__dirname, '..')
const ROOTS = ['kernel', 'utils', 'picking']

// Directories the scanned roots may not import from. Compared against the
// resolved target path, so the alias, a relative hop and a dynamic import all
// land on the same check.
const FORBIDDEN = ['components', 'stores'].map((dir) => join(SRC, dir))

/**
 * Sanctioned exceptions. A file joins this list only when it is not part of the
 * neutral solver path and its dependency on the UI tree or the stores layer is
 * deliberate. Every entry is asserted to still exist and still violate.
 */
const ALLOWLIST = new Set([
  // Main-thread services that drive the stores by design.
  'utils/core/commandRegistry.ts',  // dispatches the keymap's commands onto the editor stores
  'utils/partExport.ts',            // resolves referenced STEP bytes from the file registry
  'utils/assemblyExport.ts',        // same file-registry read for assembly export
  // Type-only store reads: the drag-state shape, erased at runtime.
  'utils/assemblyPointer.ts',
  'utils/geometry/edgeDragPreview.ts',
  // Interaction-layer ID registration reading pure geometry / drag helpers from
  // the components tree. Picking is not a neutral leaf; the A-4 edge fixed here
  // is its use of the stores, which is what the rule still guards.
  'picking/useEdgeIdRegistration.ts',
  'picking/useFaceIdRegistration.ts',
  'picking/useSketchIdRegistration.ts',
  'picking/useVertexIdRegistration.ts',
])

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /(?:^|\s)\/\/[^\n]*/g

// Blank out comments while preserving line count, so a doc comment naming the
// UI tree cannot fail the scan and line numbers in a failure stay accurate.
function stripComments(text: string): string {
  return text
    .replace(BLOCK_COMMENT, (m) => m.replace(/[^\n]/g, ' '))
    .replace(LINE_COMMENT, (m) => m.replace(/[^\n]/g, ' '))
}

// Static `from` clauses (import and re-export, type-only included),
// side-effect imports, and dynamic `import()`. The negated classes span
// newlines on purpose: a multi-line named-import list is one statement.
const SPECIFIERS = [
  /(?:^|\n)\s*(?:import|export)\s[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function collect(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collect(full))
    else if (['.ts', '.tsx'].includes(extname(entry))) out.push(full)
  }
  return out
}

function isTestFile(path: string): boolean {
  return path.includes('__tests__') || /\.test\.tsx?$/.test(path)
}

// Resolve an `@/` alias or relative specifier to an on-disk source file.
// Returns null for bare packages, Vite loader hints (`?url`) and misses.
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const clean = specifier.split('?')[0]
  const base = clean.startsWith('@/')
    ? join(SRC, clean.slice(2))
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

function isForbidden(target: string): boolean {
  return FORBIDDEN.some((root) => target === root || target.startsWith(root + sep))
}

interface ForbiddenImport {
  rel: string
  line: number
  specifier: string
}

// Every forbidden import in one file, regardless of the allowlist.
function scanFile(file: string): ForbiddenImport[] {
  const rel = file.slice(SRC.length + 1)
  const text = stripComments(readFileSync(file, 'utf8'))
  const hits: ForbiddenImport[] = []
  for (const pattern of SPECIFIERS) {
    for (const match of text.matchAll(pattern)) {
      const target = resolveSpecifier(file, match[1])
      if (!target || !isForbidden(target)) continue
      const line = text.slice(0, match.index ?? 0).split('\n').length
      hits.push({ rel, line, specifier: match[1] })
    }
  }
  return hits
}

function scanRoots(): { checked: number; hits: ForbiddenImport[] } {
  const hits: ForbiddenImport[] = []
  let checked = 0
  for (const root of ROOTS) {
    for (const file of collect(join(SRC, root))) {
      if (isTestFile(file)) continue
      checked++
      hits.push(...scanFile(file))
    }
  }
  return { checked, hits }
}

describe('kernel/utils/picking import boundary', () => {
  it('does not import from the UI tree or the stores layer', () => {
    const { checked, hits } = scanRoots()
    const violations = hits
      .filter((hit) => !ALLOWLIST.has(hit.rel))
      .map((hit) => `${hit.rel}:${hit.line}: imports ${hit.specifier}`)
    expect(violations).toEqual([])
    // Guards the guard: a broken walk would report a clean tree on zero files.
    expect(checked).toBeGreaterThan(50)
  })

  it('allowlists only files that still exist and still violate the rule', () => {
    // A stale allowlist entry would silently exempt a path nobody uses and
    // could mask a future re-introduction of the same name elsewhere.
    const found = new Set(scanRoots().hits.map((hit) => hit.rel).filter((rel) => ALLOWLIST.has(rel)))
    expect([...found].sort()).toEqual([...ALLOWLIST].sort())
  })

  it('resolves the alias and a relative hop onto the same forbidden target', () => {
    // A scan that only matched the `@/` alias would miss the identical edge
    // written relatively from a kernel file.
    const fromFile = join(SRC, 'kernel', 'query.ts')
    for (const specifier of ['@/components/Viewport/bodyUtils', '../../src/components/Viewport/bodyUtils']) {
      const target = resolveSpecifier(fromFile, specifier)
      expect(target, specifier).not.toBeNull()
      expect(isForbidden(target as string), specifier).toBe(true)
    }
  })

  it('recognises dynamic import() specifiers', () => {
    const matches: string[] = []
    for (const pattern of SPECIFIERS) {
      for (const match of `const m = import('@/components/foo')`.matchAll(pattern)) matches.push(match[1])
    }
    expect(matches).toContain('@/components/foo')
  })
})
