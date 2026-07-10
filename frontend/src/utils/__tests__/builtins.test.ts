import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const BUILTINS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'builtins.ts')

// Regression guard for the Stage G seam repair (multi-part-assembly-postfix):
// the part editor's builtins module must not import from the assembly's
// kernel layer. Assembly-owned code depends downward on the part editor's
// kernel, never the reverse; ASSEMBLY_* symbols live in assemblyBuiltins.ts.
describe('builtins.ts import direction', () => {
  it('has no import from @/kernel/*', () => {
    const text = readFileSync(BUILTINS_PATH, 'utf8')
    expect(/from ['"]@\/kernel\//.test(text)).toBe(false)
  })
})
