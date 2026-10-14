// @vitest-environment node
// Structural guard for the part path: the session/solver publication store
// never merges a React snapshot. `setSnapshot` survives only for the assembly
// editor (stores/assemblyStore.ts, pages/AssemblyEditor.tsx), whose mirror the
// parallel one-history work owns; a new call from anything part-side is a
// regression to the two-sources-of-truth seam this change removed.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url))

function collectFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files.push(...collectFiles(path))
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) files.push(path)
  }
  return files
}

const CALL_RE = /\.setSnapshot\s*\(/

describe('the part path never merges a snapshot', () => {
  it('every setSnapshot call site belongs to the assembly editor', () => {
    const violations: string[] = []
    for (const file of collectFiles(SRC_DIR)) {
      const rel = file.slice(SRC_DIR.length)
      if (rel.toLowerCase().includes('assembly')) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      for (const [index, line] of lines.entries()) {
        if (CALL_RE.test(line) && !line.includes('useAssemblyStore')) {
          violations.push(`${rel}:${index + 1}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('the part store module defines no setSnapshot action', () => {
    const source = readFileSync(join(SRC_DIR, 'stores/partEditorStore.ts'), 'utf8')
    expect(CALL_RE.test(source)).toBe(false)
  })
})
