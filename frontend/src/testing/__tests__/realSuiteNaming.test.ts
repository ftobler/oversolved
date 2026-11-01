// @vitest-environment node
//
// The *Real naming convention, enforced. Every suite that imports the OCC
// loader instantiates a WASM kernel (or at least needs one installed), and
// vitest.config.ts, the docs and the skip guards all key on the suffix: a
// missing OCC.js is a skip for a *Real suite and a failure for a provisioned
// job. A kernel-backed suite under a plain name hides that contract and, worse,
// invites a reader to assume it covers an unprovisioned checkout.
//
// This guard is a ratchet on the convention itself: any test file importing
// `loadOcc` must end in `Real.test.ts` (or `.real.test.ts`). Pure cases in a
// mixed file stay in the plain file, and the kernel half moves to the Real one.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

const SRC = join(process.cwd(), 'src')
// This file's own sample imports would flag it; it imports no kernel.
const SELF = 'realSuiteNaming.test.ts'

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...testFiles(path))
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

// A named import of loadOcc from the loader module, across line breaks.
const OCC_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*loadOcc['"]/g

function importsLoadOcc(text: string): boolean {
  for (const match of text.matchAll(OCC_IMPORT)) {
    const names = match[1].split(',').map(part => part.trim().replace(/^type\s+/, '').split(' as ')[0])
    if (names.includes('loadOcc')) return true
  }
  return false
}

describe('the *Real suite naming convention', () => {
  it('names every test file that imports loadOcc with a Real suffix', () => {
    const offenders: string[] = []
    for (const path of testFiles(SRC)) {
      if (path.endsWith(SELF)) continue
      if (!importsLoadOcc(readFileSync(path, 'utf8'))) continue
      if (!/Real\.test\.tsx?$/.test(path)) offenders.push(relative(process.cwd(), path))
    }
    expect(offenders, 'kernel-backed suites must be named *Real.test.ts (or .real.test.ts)').toEqual([])
  })

  it('sees the loader imports it is guarding', () => {
    // A regex that matched nothing would pass the guard vacuously.
    const sample = 'import { loadOcc, occInstalled } from "@/kernel/occ/loadOcc"\n'
    expect(importsLoadOcc(sample)).toBe(true)
    expect(importsLoadOcc('import { occInstalled } from "@/kernel/occ/loadOcc"\n')).toBe(false)
  })
})
