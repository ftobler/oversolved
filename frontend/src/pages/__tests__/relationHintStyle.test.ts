// The related-row hint is CSS only: jsdom applies no stylesheet, so the sheet
// is the source of truth. A selected row marks what it relates to with the
// background tint alone (user, 2026-11-23): no outline and no text colour
// change. The selected-and-related companion is the accepted selection look
// and keeps the selection outline and text colour.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PART_CSS = readFileSync(join(__dirname, '../Part.css'), 'utf8')

// The declarations of the rule whose selector is exactly `selector`.
function rulePart(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = PART_CSS.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in pages/Part.css`).not.toBeNull()
  return match![1]
}

describe('relation hint styling', () => {
  for (const selector of ['.feature-item.related', '.part-item.related']) {
    it(`marks ${selector} with the background tint alone`, () => {
      const body = rulePart(selector)
      expect(body).toMatch(/background:\s*#122028/)
      expect(body).not.toMatch(/\boutline\s*:/)
      expect(body).not.toMatch(/(?:^|[\s;])color\s*:/)
    })
  }

  for (const selector of ['.feature-item.selected.related', '.part-item.selected.related']) {
    it(`keeps the accepted selection look on ${selector}`, () => {
      const body = rulePart(selector)
      expect(body).toMatch(/outline:\s*1px solid #1e3a4a/)
      expect(body).toMatch(/color:\s*white/)
    })
  }
})
