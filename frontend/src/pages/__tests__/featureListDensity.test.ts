// The side panel row spacing is CSS only, and jsdom applies no stylesheet, so
// the sheet that owns it is the source of truth: the shared token, its value,
// and the feature row consuming it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '../..')
const PART_CSS = readFileSync(join(SRC, 'pages/Part.css'), 'utf8')

// The declarations of the first rule whose selector is exactly `selector`.
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = PART_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in pages/Part.css`).not.toBeNull()
  return match![1]
}

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(ruleBody(':root'))
  expect(match, `${name} in :root`).not.toBeNull()
  return match![1].trim()
}

// The tallest child of a row is the action button pair / slot, sized by the
// grouped button rule under `.feature-item`; the row margin is the 2px above
// and below it. A row that gains a taller child changes its height, not this.
const ACTION_BTN = 28

describe('feature list density', () => {
  it('keeps the row rhythm in one shared token', () => {
    // Declared on :root rather than on one list, so the parts list can take the
    // same value without restating it.
    expect(token('--list-row-pad-block')).toBe('7px')
  })

  it('trims the feature row by a few percent', () => {
    const row = ruleBody('.feature-item')
    expect(row).toMatch(/padding:\s*var\(--list-row-pad-block\)\s+8px/)
    const margin = Number(/margin:\s*(\d+)px 0/.exec(row)![1])

    const pad = Number.parseFloat(token('--list-row-pad-block'))
    const height = ACTION_BTN + 2 * pad + 2 * margin
    const previous = ACTION_BTN + 2 * 8 + 2 * margin
    expect(height).toBe(46)
    expect((previous - height) / previous).toBeCloseTo(0.042, 3)
  })

  it('keeps the action buttons and icons legible on a denser row', () => {
    const buttons = /\.feature-edit-btn,[\s\S]*?\.part-context-btn\s*\{([^}]*)\}/.exec(PART_CSS)![1]
    expect(buttons).toMatch(/height:\s*28px/)
    expect(ruleBody('.feature-icon')).toMatch(/width:\s*20px/)
    expect(ruleBody('.feature-icon')).toMatch(/height:\s*20px/)
  })
})
