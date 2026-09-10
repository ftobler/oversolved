/**
 * Enforce code conventions across the frontend source tree.
 * These tests catch regressions in naming and environment-access patterns.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { builtinModules } from 'node:module'
import { dirname, extname, join } from 'path'

const SRC = join(__dirname, '../../')

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full, exts))
    } else if (exts.includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

const tsFiles = collectFiles(SRC, ['.ts', '.tsx'])
// "Source" means what Vite bundles, and the two rules below (no `process.env`,
// no underscore-prefixed exports) are both about that: one breaks at runtime in
// a browser, the other is an API-surface rule. Most tests live in a `__tests__`
// directory, but the kernel's real-OCC harnesses sit beside the module they
// drive, so the directory alone is not the test predicate -- a `*.test.ts`
// anywhere is a test and ships in nothing.
const srcOnlyFiles = tsFiles.filter(
  f => !f.includes('__tests__') && !/\.test\.tsx?$/.test(f),
)

describe('circular dependency guards', () => {
  it('registry/ does not import from stores/', () => {
    const registryDir = join(SRC, 'registry')
    const registryFiles = collectFiles(registryDir, ['.ts', '.tsx'])
      .filter(f => !f.includes('__tests__'))
    const violations: string[] = []
    for (const file of registryFiles) {
      const src = readFileSync(file, 'utf8')
      if (src.includes("from '@/stores/") || src.includes('from "@/stores/')) {
        violations.push(file.replace(SRC, 'src/'))
      }
    }
    expect(violations).toEqual([])
  })
})

describe('code conventions', () => {
  it('no underscore-prefixed exports', () => {
    const violations: string[] = []
    const re = /^export\s+(?:function|const|class|type|interface|enum)\s+_/m
    for (const file of srcOnlyFiles) {
      const src = readFileSync(file, 'utf8')
      if (re.test(src)) {
        violations.push(file.replace(SRC, 'src/'))
      }
    }
    expect(violations).toEqual([])
  })

  it('no process.env in source files (use import.meta.env)', () => {
    const violations: string[] = []
    for (const file of srcOnlyFiles) {
      const src = readFileSync(file, 'utf8')
      if (src.includes('process.env')) {
        violations.push(file.replace(SRC, 'src/'))
      }
    }
    expect(violations).toEqual([])
  })

  // A raw control byte makes `file` call the source `data` and makes plain grep
  // print nothing for it, so a search for any symbol in that file comes back empty
  // and reads as "the symbol does not exist". `query.ts` and `IdRegistry.ts` each
  // carried a raw 0x00 separator and cost a review pass real time. The separator is
  // fine, the byte in the source is not: write it as a unicode escape instead.
  it('no raw C0 control bytes in source (write them as \\uXXXX escapes)', () => {
    const allowed = new Set([0x09, 0x0a, 0x0d])  // tab, LF, CR
    expect(tsFiles.length).toBeGreaterThan(100)  // a broken walk would pass vacuously
    const violations: string[] = []
    for (const file of tsFiles) {
      const bytes = readFileSync(file)
      const hits: string[] = []
      let line = 1
      for (let i = 0; i < bytes.length && hits.length < 3; i++) {
        if (bytes[i] === 0x0a) line++
        else if (bytes[i] < 0x20 && !allowed.has(bytes[i])) {
          hits.push(`0x${bytes[i].toString(16).padStart(2, '0')} at line ${line}`)
        }
      }
      if (hits.length > 0) {
        violations.push(`${file.replace(SRC, 'src/')} (${hits.join(', ')})`)
      }
    }
    expect(violations).toEqual([])
  })
})

// The assembly's pose is composed by the store accessor (settledPose /
// settledPoses) and the pure helpers (poseOffsetFor / drawnPose). A file that
// reaches into the raw `transforms` / `settlingOffsets` fields re-derives that
// composition and can silently forget the settling offset, which is exactly how
// a structural edit between a drag commit and its re-solve reverted the drag.
// Only the files that own or subscribe to the pose plumbing may read the raw
// fields; everyone else goes through the accessor.
describe('assembly pose reads are confined to the pose plumbing', () => {
  const ALLOWLIST = new Set([
    'stores/assemblyStore.ts',
    'hooks/useAssemblySolve.ts',
    'utils/assemblyRender.ts',
    'components/Viewport/AssemblyViewport.tsx',
  ])

  const FORBIDDEN = [
    /getState\(\)\.transforms/,
    /getState\(\)\.settlingOffsets/,
    /\bs\s*=>\s*s\.transforms\b/,
    /\bs\s*=>\s*s\.settlingOffsets\b/,
    /\bstate\.transforms\b/,
    /\bstate\.settlingOffsets\b/,
  ]

  // Comments are stripped so a doc comment naming a raw field (this file's own
  // rationale included) cannot fail the scan.
  const COMMENTS = [/\/\*[\s\S]*?\*\//g, /(?:^|\s)\/\/[^\n]*/g]

  it('reports the file and line of any raw pose read outside the allowlist', () => {
    const violations: string[] = []
    let allowlistHits = 0
    for (const file of srcOnlyFiles) {
      const rel = file.replace(SRC, 'src/')
      let text = readFileSync(file, 'utf8')
      for (const pattern of COMMENTS) text = text.replace(pattern, '')
      text.split('\n').forEach((line, i) => {
        if (!FORBIDDEN.some(re => re.test(line))) return
        if (ALLOWLIST.has(rel.slice('src/'.length))) allowlistHits++
        else violations.push(`${rel}:${i + 1}`)
      })
    }
    expect(violations).toEqual([])
    // Guards the guard: a regex that stopped matching would pass on an empty set
    // and report a clean tree forever.
    expect(allowlistHits).toBeGreaterThan(0)
  })
})

// A package that is only ever installed because something else happens to
// depend on it works right up until that something else drops it or moves to a
// different major, at which point the build breaks for a reason nothing in this
// repo explains. `three-stdlib` sat like that for months: imported directly by
// three viewport modules, declared nowhere, present only as a transitive of
// @react-three/drei. Type-only imports make it worse, because they vanish from
// the bundle and so never show up as a runtime failure.
//
// Deliberately a source-text scan and not a resolver: it answers "did we write
// this dependency down", which is the thing that rots, and it does so without
// needing node_modules to be installed at all.
describe('declared dependencies', () => {
  const PKG = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const declared = new Set([
    ...Object.keys(PKG.dependencies ?? {}),
    ...Object.keys(PKG.devDependencies ?? {}),
  ])
  const builtins = new Set(builtinModules)

  // Comments are stripped first so a specifier quoted in prose (or an import
  // left commented out) cannot be mistaken for a live one. Same shape as
  // noCdnAssets.test.ts's INERT list, and safe for `'https://...'` because the
  // line-comment pattern requires a line start or whitespace before the slashes.
  const COMMENTS = [/\/\*[\s\S]*?\*\//g, /(?:^|\s)\/\/[^\n]*/g]
  // Static `from` clauses (import and re-export, type-only included),
  // side-effect imports, and dynamic `import()`. The negated classes span
  // newlines on purpose: a multi-line named-import list is one statement.
  const SPECIFIERS = [
    /(?:^|\n)\s*(?:import|export)\s[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  /** The package a specifier names, i.e. what has to appear in package.json. */
  function packageOf(specifier: string): string {
    const path = specifier.split('?')[0].split('/')  // drop Vite's ?url / ?worker suffix
    return specifier.startsWith('@') ? path.slice(0, 2).join('/') : path[0]
  }

  // Bare specifiers only: relative paths, the `@/` alias and node builtins are not packages.
  function isBarePackage(specifier: string): boolean {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/')) return false
    if (specifier.startsWith('node:')) return false
    return !builtins.has(packageOf(specifier))
  }

  const imports = new Map<string, string[]>()  // package -> files importing it
  for (const file of tsFiles) {
    let text = readFileSync(file, 'utf8')
    for (const pattern of COMMENTS) text = text.replace(pattern, '')
    for (const pattern of SPECIFIERS) {
      for (const match of text.matchAll(pattern)) {
        if (!isBarePackage(match[1])) continue
        const name = packageOf(match[1])
        const where = imports.get(name)
        if (where) where.push(file.replace(SRC, 'src/'))
        else imports.set(name, [file.replace(SRC, 'src/')])
      }
    }
  }

  it('finds the imports it is supposed to be checking', () => {
    // Guards the guard. A regex that stops matching would make the rule below
    // pass on an empty set and report a clean tree forever.
    expect(imports.size).toBeGreaterThan(10)
    expect([...imports.keys()]).toEqual(expect.arrayContaining(['react', 'three', 'zustand', 'vitest']))
  })

  it('declares every package src/ imports in package.json', () => {
    const undeclared = [...imports]
      .filter(([name]) => !declared.has(name))
      .map(([name, files]) => `${name} (e.g. ${files[0]})`)
      .sort()
    expect(undeclared).toEqual([])
  })
})

// The sketch editor store and its selection helpers advertise themselves as
// pure headless logic ("delete the Viewport, the logic still passes"), which
// only holds while nothing in their transitive import closure touches the
// Three.js / R3F layer. geometryMapping once reached `three` through the
// sketchHelpers re-export of ellipseAxisPoints; that link now points at the
// pure ellipseAxis module. This closure walk keeps future imports from silently
// pulling the rendering layer into the headless tests again.
describe('headless module purity', () => {
  const HEADLESS_ROOTS = [
    'stores/sketchEditorStore.ts',
    'picking/selectionHighlight.ts',
    'stores/stateInvariants.ts',
    'picking/highlightActive.ts',
    'picking/pickKey.ts',
  ]

  const COMMENTS = [/\/\*[\s\S]*?\*\//g, /(?:^|\s)\/\/[^\n]*/g]
  const SPECIFIERS = [
    /(?:^|\n)\s*(?:import|export)\s[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  // Resolve an `@/` alias or relative specifier to an on-disk source file.
  // Returns null for bare packages and anything that does not exist. The `?`
  // suffix drops Vite's loader hints (?url / ?worker), same as the package
  // scan above.
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

  function closureImports(): { threeSpecifiers: string[]; files: string[] } {
    const seen = new Set<string>()
    const threeSpecifiers: string[] = []
    const queue = HEADLESS_ROOTS.map(root => join(SRC, root))
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      let text = readFileSync(file, 'utf8')
      for (const pattern of COMMENTS) text = text.replace(pattern, '')
      for (const pattern of SPECIFIERS) {
        for (const match of text.matchAll(pattern)) {
          const specifier = match[1]
          if (specifier === 'three' || specifier.startsWith('@react-three/')) {
            threeSpecifiers.push(`${file.replace(SRC, 'src/')} -> ${specifier}`)
          }
          const target = resolveSpecifier(file, specifier)
          if (target) queue.push(target)
        }
      }
    }
    const files = [...seen].map(f => f.replace(SRC, 'src/')).sort()
    return { threeSpecifiers, files }
  }

  it('transitive closure of the headless modules contains no three import', () => {
    const { threeSpecifiers, files } = closureImports()
    // Guards the guard: a broken resolver would report a clean closure on zero
    // files, so pin the deep modules that only reach the closure through the
    // store-to-geometryMapping chain.
    expect(files).toEqual(expect.arrayContaining([
      expect.stringContaining('stores/sketchEditorStore.ts'),
      expect.stringContaining('utils/geometry/geometryMapping.ts'),
      expect.stringContaining('utils/geometry/ellipseAxis.ts'),
    ]))
    expect(threeSpecifiers).toEqual([])
  })
})
