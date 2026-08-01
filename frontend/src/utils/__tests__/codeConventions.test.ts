/**
 * Enforce code conventions across the frontend source tree.
 * These tests catch regressions in naming and environment-access patterns.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { builtinModules } from 'node:module'
import { join, extname } from 'path'

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

  /** Bare specifiers only: relative paths, the `@/` alias and node builtins are not packages. */
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
