import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PART_CSS = readFileSync(join(__dirname, '../Part.css'), 'utf8')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = PART_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in pages/Part.css`).not.toBeNull()
  return match![1]
}

describe('field layout invariant', () => {
  it('gives the field input a min-width floor', () => {
    expect(ruleBody('.feature-field-input')).toMatch(/min-width:/)
  })

  it('does not give a non-stacked field row child flex-basis 100%', () => {
    // Scan every rule: a flex-basis: 100% on a .feature-field-row child is only
    // allowed when the selector names the stacked or wrapping variant.
    const ruleRe = /([^{}]+)\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = ruleRe.exec(PART_CSS)) !== null) {
      const selector = m[1].trim()
      const body = m[2]
      if (!/flex-basis:\s*100%/.test(body)) continue
      if (!selector.includes('.feature-field-row')) continue

      const allowed = selector.includes('--stacked') || selector.includes(':has(')
      expect(allowed, `disallowed flex-basis: 100% in ${selector}`).toBe(true)
    }
  })
})
