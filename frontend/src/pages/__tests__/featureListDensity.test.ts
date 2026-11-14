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
// grouped button rule under `.feature-item` and `.part-item`; the row margin is
// the 2px above and below it. A row that gains a taller child changes its
// height, not this.
const ACTION_BTN = 28

function rowHeight(selector: string): number {
  const row = ruleBody(selector)
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
    const row = ruleBody('.feature-item')
    expect(row).toMatch(/padding:\s*var\(--list-row-pad-block\)\s+8px/)
    const margin = Number(/margin:\s*(\d+)px 0/.exec(row)![1])

    const pad = Number.parseFloat(token('--list-row-pad-block'))
    const height = ACTION_BTN + 2 * pad + 2 * margin
    const previous = ACTION_BTN + 2 * 8 + 2 * margin
    expect(height).toBe(46)
    expect((previous - height) / previous).toBeCloseTo(0.042, 3)
  })

  it('gives the parts row the same token and the same row height', () => {
    const row = ruleBody('.part-item')
    expect(row).toMatch(/padding:\s*var\(--list-row-pad-block\)\s+8px/)
    expect(rowHeight('.part-item')).toBe(rowHeight('.feature-item'))
    expect(rowHeight('.part-item')).toBe(46)
  })

  it('keeps the action buttons and icons legible on a denser row', () => {
    const buttons = /\.feature-edit-btn,[\s\S]*?\.part-context-btn\s*\{([^}]*)\}/.exec(PART_CSS)![1]
    expect(buttons).toMatch(/height:\s*28px/)
    expect(ruleBody('.feature-icon')).toMatch(/width:\s*20px/)
    expect(ruleBody('.feature-icon')).toMatch(/height:\s*20px/)
  })
})

describe('side panel height split', () => {
  // The two cards are flex children of .document-panel: the grow factors share
  // the height the panel reserves, so a larger factor is a larger card.
  function grow(selector: string): number {
    const match = /flex:\s*(\d+) 1 0/.exec(ruleBody(selector))
    expect(match, `${selector} grow factor`).not.toBeNull()
    return Number(match![1])
  }

  it('gives the features card the larger share and the parts card the smaller one', () => {
    expect(grow('.document-panel > .sidebar-top')).toBe(64)
    expect(grow('.document-panel > .sidebar-bottom')).toBe(36)
    expect(grow('.document-panel > .sidebar-top')).toBeGreaterThan(grow('.document-panel > .sidebar-bottom'))
  })

  it('leaves both cards above their minimum so neither list collapses', () => {
    // 36% of the 85% panel share still clears the 60px min-height the shared
    // card rules give each side on any viewport tall enough to show the column.
    expect(grow('.document-panel > .sidebar-bottom')).toBeGreaterThan(0)
    expect(ruleBody('.sidebar-top')).toMatch(/min-height:\s*60px/)
    expect(ruleBody('.sidebar-bottom')).toMatch(/min-height:\s*60px/)
  })
})
