import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * 267.6 / 267.7: Verify no `noOpRaycast` shim remains in `frontend/src`.
 */
const SRC = join(__dirname, '../../../../src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      out.push(...sourceFiles(p))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(p)
    }
  }
  return out
}

describe('noOpRaycast is fully removed from production source', () => {
  const files = sourceFiles(SRC)

  it('no source file defines or exports noOpRaycast', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = f.replace(SRC, '')
      if (rel.includes('__tests__')) continue

      const src = readFileSync(f, 'utf8')
      if (/noOpRaycast/.test(src)) {
        offenders.push(rel)
      }
    }
    expect(offenders, `files still referencing noOpRaycast: ${offenders.join(', ')}`).toEqual([])
  })

  it('no source file defines or uses noRaycast', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = f.replace(SRC, '')
      if (rel.includes('__tests__')) continue
      const src = readFileSync(f, 'utf8')
      if (/noRaycast/.test(src)) {
        offenders.push(rel)
      }
    }
    expect(offenders, `files still referencing noRaycast: ${offenders.join(', ')}`).toEqual([])
  })
})
