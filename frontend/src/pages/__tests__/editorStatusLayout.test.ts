// The status line's alignment and the plane editor's missing divider are CSS
// only: jsdom applies no stylesheet, so the sheet that owns them is the source
// of truth here, as in featureListDensity.test.ts. The line has to say
// left-aligned itself because index.css centers text app-wide on `#root`, and
// it has to stretch because a flex parent would otherwise shrink the mark to a
// centred pill.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PART_CSS = readFileSync(join(__dirname, '../Part.css'), 'utf8')
const GLASS_CSS = readFileSync(join(__dirname, '../../components/layout/Glass.css'), 'utf8')

// The declarations of the first rule whose selector is exactly `selector`.
function rulePart(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = PART_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in pages/Part.css`).not.toBeNull()
  return match![1]
}

describe('editor status line', () => {
  it('starts at the left edge whatever the ancestor aligns', () => {
    const part = rulePart('.status-message')
    expect(part).toMatch(/text-align:\s*left/)
    expect(part).toMatch(/align-self:\s*stretch/)
  })

  it('still carries the level colours the tree rows use', () => {
    expect(rulePart('.status-message--error')).toMatch(/color:\s*#f44336/)
    expect(rulePart('.status-message--warning')).toMatch(/color:\s*#ecad2b/)
  })
})

describe('status card in the right column', () => {
  it('joins the column flow after the edit panel', () => {
    // In flow with the stack's own gap: a mark pushes the cards below it down,
    // scrolls with the column on a phone and cannot land over the HUD band.
    expect(rulePart('.right-overlay-stack')).toMatch(/gap:\s*12px/)
    const part = rulePart('.feature-status-panel')
    expect(part).toMatch(/display:\s*flex/)
    expect(part).not.toMatch(/position:/)
  })
})

describe('status card icon size', () => {
  it('sizes the header icons and the status mark from one shared token', () => {
    // The card's header lives in Glass.css, the mark's card in Part.css; neither
    // may restate the size or the wrap card would drift from the editor above.
    expect(GLASS_CSS).toMatch(/:root\s*\{[^}]*--icon-size:\s*20px/)
    expect(GLASS_CSS).toMatch(/\.feature-icon\s*\{[^}]*width:\s*var\(--icon-size\)/)
    expect(GLASS_CSS).toMatch(/\.feature-icon\s*\{[^}]*height:\s*var\(--icon-size\)/)
    expect(GLASS_CSS).toMatch(/\.feature-rename-btn img,[\s\S]*?\{[^}]*width:\s*var\(--icon-size\)/)
    const icon = rulePart('.feature-status-icon')
    expect(icon).toMatch(/width:\s*var\(--icon-size\)/)
    expect(icon).toMatch(/height:\s*var\(--icon-size\)/)
    expect(icon).not.toMatch(/margin-top/)
  })

  it('centres the mark on the first line of a wrapped message', () => {
    expect(rulePart('.feature-status-panel')).toMatch(/gap:\s*8px/)
    expect(rulePart('.feature-status-panel .status-message')).toMatch(/line-height:\s*var\(--icon-size\)/)
  })
})

describe('plane editor frame', () => {
  it('draws no divider above the fields', () => {
    expect(rulePart('.plane-editor')).not.toMatch(/border/)
  })

  it('separates from the line above by the same gap as its rows', () => {
    // With the border gone the old padding-top had nothing left to hold the
    // rows off, so the margin carries the whole separation.
    const part = rulePart('.plane-editor')
    const gap = Number(/gap:\s*(\d+)px/.exec(part)![1])
    const margin = Number(/margin-top:\s*(\d+)px/.exec(part)![1])
    expect(margin).toBe(gap)
    expect(part).not.toMatch(/padding-top/)
  })
})
