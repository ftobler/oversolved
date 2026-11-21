// The side panel row spacing is CSS only, and jsdom applies no stylesheet, so
// the sheet that owns it is the source of truth: the shared token, its value,
// and both lists consuming it. The height split between the two cards is in
// the same sheet and is pinned here for the same reason.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '../..')
const PART_CSS = readFileSync(join(SRC, 'pages/Part.css'), 'utf8')

// The declarations of the first rule whose selector is exactly `selector`.
function rulePart(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = PART_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in pages/Part.css`).not.toBeNull()
  return match![1]
}

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(rulePart(':root'))
  expect(match, `${name} in :root`).not.toBeNull()
  return match![1].trim()
}

// The tallest child of a row is the action button pair / slot, sized by the
// grouped button rule under `.feature-item` and `.part-item`; the row margin is
// the 2px above and below it. A row that gains a taller child changes its
// height, not this.
const ACTION_BTN = 28

function rowHeight(selector: string): number {
  const row = rulePart(selector)
  const margin = Number(/margin:\s*(\d+)px 0/.exec(row)![1])
  const padding = /padding:\s*var\(--list-row-pad-block\)/.test(row)
    ? Number.parseFloat(token('--list-row-pad-block'))
    : Number(/padding:\s*(\d+)px/.exec(row)![1])
  return ACTION_BTN + 2 * padding + 2 * margin
}

describe('feature list density', () => {
  it('keeps the row rhythm in one shared token', () => {
    // Declared on :root rather than on one list, so the parts list can take the
    // same value without restating it.
    expect(token('--list-row-pad-block')).toBe('7px')
  })

  it('trims the feature row by a few percent', () => {
    const row = rulePart('.feature-item')
    expect(row).toMatch(/padding:\s*var\(--list-row-pad-block\)\s+8px/)
    const margin = Number(/margin:\s*(\d+)px 0/.exec(row)![1])

    const pad = Number.parseFloat(token('--list-row-pad-block'))
    const height = ACTION_BTN + 2 * pad + 2 * margin
    const previous = ACTION_BTN + 2 * 8 + 2 * margin
    expect(height).toBe(46)
    expect((previous - height) / previous).toBeCloseTo(0.042, 3)
  })

  it('gives the parts row the same token and the same row height', () => {
    const row = rulePart('.part-item')
    expect(row).toMatch(/padding:\s*var\(--list-row-pad-block\)\s+8px/)
    expect(rowHeight('.part-item')).toBe(rowHeight('.feature-item'))
    expect(rowHeight('.part-item')).toBe(46)
  })

  it('keeps the action buttons and icons legible on a denser row', () => {
    const buttons = /\.feature-edit-btn,[\s\S]*?\.part-context-btn\s*\{([^}]*)\}/.exec(PART_CSS)![1]
    expect(buttons).toMatch(/height:\s*28px/)
    expect(rulePart('.feature-icon')).toMatch(/width:\s*20px/)
    expect(rulePart('.feature-icon')).toMatch(/height:\s*20px/)
  })
})

describe('side panel height split', () => {
  // The height token is pinned as written because jsdom applies no stylesheet;
  // the arithmetic below evaluates it the way the browser does, against the
  // column the cards live in (.floating-left between the top inset and the
  // bottom readout clearance).
  function gapMax(): number {
    const value = token('--left-cards-gap-max')
    expect(value).toMatch(/^\d+px$/)
    return Number.parseFloat(value)
  }

  // The pair's height: the token's two terms, whichever is more. A short column
  // resolves to the capped-gap term, a tall one to the 85% term.
  function basis(column: number): number {
    return Math.max(0.85 * column, column - 2 * gapMax())
  }

  it('caps the outer gap on a short column instead of scaling it', () => {
    expect(gapMax()).toBe(24)
    expect(token('--left-cards-height'))
      .toBe('max(85%, 100% - 2 * var(--left-cards-gap-max))')
  })

  it('spends the spare height on the cards on a short column', () => {
    // The capped term beats the 85% share exactly when 15% of the column is
    // wider than the 48px the cap allows. That holds for 400px and for the
    // report's 818px column, where the old share left all 15% empty.
    const cap = 2 * gapMax()
    expect(cap).toBe(48)
    for (const column of [400, 818]) {
      expect(0.15 * column).toBeGreaterThan(cap)
    }
  })

  it('keeps the tall desktop on the 85% share and its centred gap', () => {
    // 1200px clears a 1080p window's inner height (about 950-1000), so a normal
    // desktop gets the capped layout and only a truly tall one keeps the old
    // look. The reset must also come after the token: source order is what lets
    // it win.
    expect(PART_CSS)
      .toMatch(/@media \(min-height: 1200px\) \{\s*:root \{\s*--left-cards-height: 85%;\s*\}\s*\}/)
    const tokenAt = PART_CSS.indexOf('--left-cards-height: max(')
    const resetAt = PART_CSS.indexOf('--left-cards-height: 85%;')
    expect(tokenAt).toBeGreaterThan(-1)
    expect(resetAt).toBeGreaterThan(tokenAt)
    // Without the reset the capped term would win there too and nearly fill the
    // column; the 15% gap is the deliberate desktop look.
    expect(0.15 * 1400).toBeGreaterThan(2 * gapMax())
  })

  it('gives the top card the leftover height and lets the bottom hug its list', () => {
    // Nothing is reserved for the bottom card up front: it takes its content
    // height, and the top card grows into the rest.
    expect(rulePart('.document-panel > .sidebar-top')).toMatch(/flex:\s*1 1 0/)

    const bottom = rulePart('.document-panel > .sidebar-bottom')
    expect(bottom).toMatch(/flex:\s*0 1 auto/)
    expect(bottom).toMatch(/max-height:\s*36%/)
  })

  it('keeps the bottom card above its minimum on a short column', () => {
    // 36% of the pair's height at the shortest column still clears the 60px
    // floor, so the share caps a long list without clamping the card shut. The
    // top card deliberately keeps no floor of its own; the bottom card keeps
    // the 60px one.
    expect(0.36 * basis(400)).toBeGreaterThan(60)
    expect(rulePart('.document-panel > .sidebar-top')).toMatch(/min-height:\s*0/)
    expect(rulePart('.document-panel > .sidebar-bottom')).toMatch(/min-height:\s*60px/)
  })
})
