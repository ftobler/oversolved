// @vitest-environment node
// The structural twin of the eslint no-restricted-imports wall scoped to
// src/session: the boundary has to hold even when eslint is not the tool that
// runs (a fresh checkout, another linter, a script that skips the config).
// Scans the folder's imports against the same banned list; the eslint rule is
// the fast path, this is the backstop.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SESSION_DIR = fileURLToPath(new URL('..', import.meta.url))

// The exact banned list the eslint wall uses. The bare names match exactly and
// the '/' suffixes match subpaths, so `three-stdlib` is not caught by `three`.
const BANNED_EXACT = ['react', 'react-dom', 'three'] as const
const BANNED_PREFIXES = [
  'react/', 'react-dom/', 'three/', '@react-three/',
  '@/stores/', '@/components/', '@/pages/', '@/hooks/',
] as const

// The two pure handler tables the session reads until the adapter rewrite
// moves them into this folder: they import no React, no three and no store.
// The frozen transcript tables' step/result types are test-only and imported
// type-only (erased at build), so the shared table has one definition.
const EXEMPT = new Set([
  '@/hooks/mutationDispatch',
  '@/hooks/mutationIdempotence',
  '@/hooks/__tests__/historyTranscript',
])

// The import forms the repo uses. The pattern needs a specifier in quotes, so
// comments must not quote an import specifier for the scan to stay honest.
const IMPORT_RE = /^[ \t]*(?:import|export)\b[\s\S]*?from\s*['"]([^'"]+)['"]|^[ \t]*import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm

export function bannedImportsIn(source: string): string[] {
  const violations: string[] = []
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (EXEMPT.has(spec)) continue
    if (BANNED_EXACT.includes(spec as typeof BANNED_EXACT[number])
      || BANNED_PREFIXES.some(prefix => spec.startsWith(prefix))) {
      violations.push(spec)
    }
  }
  return violations
}

function collectFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files.push(...collectFiles(path))
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) files.push(path)
  }
  return files
}

describe('the session import wall', () => {
  const files = collectFiles(SESSION_DIR)

  it('scans every file in the folder', () => {
    expect(files.length).toBeGreaterThan(5)
    expect(files.filter(file => file.includes('DocSession.ts'))).toHaveLength(1)
  })

  it('imports nothing from React, three, the stores, the UI or the hooks', () => {
    const violations = files.flatMap(file =>
      bannedImportsIn(readFileSync(file, 'utf8')).map(spec => `${file}: ${spec}`),
    )
    expect(violations).toEqual([])
  })

  it('the scanner itself refuses a planted violation and passes the exemptions', () => {
    expect(bannedImportsIn("import { create } from 'zustand'\nimport x from '@/stores/partEditorStore'\nimport y from '@/components/Foo'\nimport z from 'react'\n"))
      .toEqual(['@/stores/partEditorStore', '@/components/Foo', 'react'])
    expect(bannedImportsIn("import { mutationHandlers } from '@/hooks/mutationDispatch'\nimport { IDEMPOTENT_MUTATION } from '@/hooks/mutationIdempotence'\n"))
      .toEqual([])
  })
})
