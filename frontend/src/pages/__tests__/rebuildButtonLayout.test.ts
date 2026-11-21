// The rebuild time label and the circular arrow are one row in the header.
// jsdom applies no stylesheet and lays nothing out, so the sheet that owns the
// row is the source of truth here, as in featureListDensity.test.ts. The label
// already comes before the button in the DOM; `inline-flex` is what puts the
// arrow to its right, where the old inline-block container stacked the button
// under the label.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PART_CSS = readFileSync(join(__dirname, '../Part.css'), 'utf8')

// The declarations of the first rule whose selector is exactly `selector`.
function rulePart(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = PART_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in pages/Part.css`).not.toBeNull()
  return match![1]
}

describe('rebuild button row', () => {
  it('keeps the label and the arrow on one line, vertically centred', () => {
    const container = rulePart('.rebuild-button-container')
    expect(container).toMatch(/display:\s*inline-flex/)
    expect(container).toMatch(/align-items:\s*center/)
    // A block-level flex button inside an inline-block container is what
    // started the new line this row replaces.
    expect(container).not.toMatch(/display:\s*inline-block/)
  })

  it('keeps the time on one line with tabular digits', () => {
    const label = rulePart('.rebuild-time-label')
    expect(label).toMatch(/white-space:\s*nowrap/)
    expect(label).toMatch(/font-variant-numeric:\s*tabular-nums/)
  })
})

describe('navigator card headers', () => {
  it('starts every title at the left edge', () => {
    const header = rulePart('.sidebar-header')
    expect(header).toMatch(/justify-content:\s*flex-start/)
    expect(header).not.toMatch(/justify-content:\s*center/)
  })

  it('matches a header without the button to the 28px rebuild line', () => {
    expect(rulePart('.sidebar-header')).toMatch(/min-height:\s*28px/)
    expect(rulePart('.rebuild-button')).toMatch(/height:\s*28px/)
  })
})
