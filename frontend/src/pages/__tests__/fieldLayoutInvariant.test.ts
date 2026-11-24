import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PART_CSS = readFileSync(join(__dirname, '../Part.css'), 'utf8')
const GLASS_CSS = readFileSync(join(__dirname, '../../components/layout/Glass.css'), 'utf8')

describe('field layout invariant', () => {
  it('gives the field input a min-width floor', () => {
    // The shared field primitives live in Glass.css so dialogs can use them
    // without importing a page stylesheet.
    expect(GLASS_CSS).toMatch(/\.feature-field-input\s*\{[^}]*min-width:/)
    // Part.css no longer owns the rule.
    expect(PART_CSS).not.toMatch(/(?:^|\n)\.feature-field-input\s*\{/)
  })

  it('does not give a non-stacked field row child flex-basis 100%', () => {
    // Scan every rule: a flex-basis: 100% on a .feature-field-row child is only
    // allowed when the selector names the stacked or wrapping variant.
    const ruleRe = /([^{}]+)\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = ruleRe.exec(PART_CSS)) !== null) {
      const selector = m[1].trim()
      const part = m[2]
      if (!/flex-basis:\s*100%/.test(part)) continue
      if (!selector.includes('.feature-field-row')) continue

      const allowed =
        selector.includes('--stacked') || selector.includes(':has(> .status-message)')
      expect(allowed, `disallowed flex-basis: 100% in ${selector}`).toBe(true)
    }
  })
})
