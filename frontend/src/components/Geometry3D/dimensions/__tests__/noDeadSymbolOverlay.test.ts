import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// dimensions/Symbol.tsx was a stale duplicate of ConstraintOverlays: the live
// implementation moved to Geometry3D/Constraints.tsx (wired in index.tsx), and
// nothing ever imported the dimensions/Symbol.tsx copy in production. This
// guard is the headstone. It fails the moment someone revives the file, and
// checks import paths rather than the bare `ConstraintOverlays` identifier,
// since that name is legitimately reused by the live component.

const SRC = join(__dirname, '../../../../')

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

describe('dead dimensions/Symbol.tsx overlay stays deleted', () => {
  it('keeps dimensions/Symbol.tsx off the disk', () => {
    expect(existsSync(join(SRC, 'components/Geometry3D/dimensions/Symbol.tsx'))).toBe(false)
  })

  it('no production source imports dimensions/Symbol', () => {
    const offenders: string[] = []
    for (const f of sourceFiles(SRC)) {
      const rel = f.replace(SRC, '')
      if (rel.includes('__tests__')) continue
      const src = readFileSync(f, 'utf8')
      if (/dimensions\/Symbol['"]|from ['"]\.\/Symbol['"]/.test(src)) {
        offenders.push(rel)
      }
    }
    expect(offenders, `files still importing dimensions/Symbol: ${offenders.join(', ')}`).toEqual([])
  })
})
