// The side panel row spacing is CSS only, and jsdom applies no stylesheet, so
// the sheet that owns it is the source of truth: the shared token, its value,
// and both lists consuming it. The height split's tokens and its arithmetic
// live here; the declarations that actually reach the cards are pinned with
// the effective-value resolver in narrowChrome.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '../..')
const PART_CSS = readFileSync(join(SRC, 'pages/Part.css'), 'utf8')

// The declarations of the first rule whose selector is exactly `selector`,
// wherever it sits (an indented rule inside a media block included).
function rulePart(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = PART_CSS.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in pages/Part.css`).not.toBeNull()
  return match![1]
}

// A custom property's value in that rule.
function declared(selector: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(rulePart(selector))
  expect(match, `${name} on ${selector}`).not.toBeNull()
  return match![1].trim()
}

function token(name: string): string {
  return declared(':root', name)
}

// A pixel token as the number the browser would compute.
function px(value: string): number {
  expect(value).toMatch(/^\d+(\.\d+)?px$/)
  return Number.parseFloat(value)
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

  // The card column, not the viewport: .floating-left runs from one floating
  // inset below the .viewport-stage top to the inset plus the readout clearance
  // above its bottom, and the stage sits under the app header and the editor
  // toolbar. Those two bar heights are pinned part by part in
  // narrowChrome.test.ts, because they are the model's other input: the header
  // is its 40px buttons plus 6px padding each side and a 1px border (53px), the
  // part editor's toolbar is also 53 (a 44px mode selector inside 4px padding
  // and a 1px border), and the assembly's lighter toolbar is 49. CssBaseline
  // (main.tsx) makes border-box global, so those heights already include the
  // padding. A test that counted the viewport as the column would allow floors
  // the real column cannot hold.
  const APP_HEADER = 53
  const PART_TOOLBAR = 53
  const ASSEMBLY_TOOLBAR = 49

  function columnFor(viewport: number, toolbar = PART_TOOLBAR): number {
    const inset = px(token('--floating-inset'))
    const clearance = px(token('--readout-clearance'))
    return viewport - APP_HEADER - toolbar - inset - (inset + clearance)
  }

  // The panel's own floor: the two card floors plus the gap between them.
  function panelFloor(top: number, bottom: number): number {
    return top + bottom + px(token('--left-cards-gap'))
  }

  // The panel's used height: its share, raised to the floor where the column
  // can hold it and clamped to the column by min(..., 100%) where it cannot.
  function panelFor(column: number, floor: number): number {
    return Math.max(basis(column), Math.min(floor, column))
  }

  // The open drawer's card column: the only rule that lowers the floors.
  const DRAWER = '.doc-container.panels-open .floating-left'

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

  it('takes the share, the floors and the gap from tokens', () => {
    // The user asked for the reservation on 2026-11-23: a content hug left the
    // Parts card at a header and one empty row.
    expect(token('--left-bottom-share')).toBe('34%')
    expect(px(token('--left-top-floor'))).toBe(160)
    expect(px(token('--left-bottom-floor'))).toBe(140)
    expect(px(token('--left-cards-gap'))).toBe(16)
  })

  it('keeps the parts list scrolling inside the fixed-basis card', () => {
    const list = rulePart('.parts-list')
    expect(list).toMatch(/overflow-y:\s*auto/)
    expect(list).toMatch(/min-height:\s*0/)
  })

  it('reserves about a third where the column can afford it', () => {
    // On a tall window the share is above the bottom floor and the rest is
    // above the top floor, so the token, not a floor, decides both cards.
    const panel = basis(columnFor(1000))
    const share = 0.34 * panel
    expect(share).toBeGreaterThan(px(token('--left-bottom-floor')))
    expect(panel - share - px(token('--left-cards-gap')))
      .toBeGreaterThan(px(token('--left-top-floor')))
  })

  it('keeps the desktop floors inside the shortest desktop column', () => {
    // 481px is the shortest window that still shows the desktop pair; the
    // drawer block starts at 480. The part editor's column there is 323, seven
    // more than the 316 the two floors need, so the panel floor sets the pair
    // and the clamp never binds on the desktop.
    const top = px(token('--left-top-floor'))
    const bottom = px(token('--left-bottom-floor'))
    const floor = panelFloor(top, bottom)
    expect(floor).toBe(316)
    const column = columnFor(481)
    expect(floor).toBeLessThanOrEqual(column)
    expect(panelFor(column, floor)).toBe(floor)
    expect(basis(column)).toBeLessThan(floor)

    // At the floor the share is under the bottom card's floor, so that card
    // keeps its floor and the top card gets exactly its own.
    expect(0.34 * floor).toBeLessThan(bottom)
    expect(floor - bottom - px(token('--left-cards-gap'))).toBe(top)
  })

  it('clamps the panel to a short drawer column', () => {
    // 568x320 landscape is a real phone turned sideways: its column is
    // 320 - 53 - 53 - 52 = 162, under the drawer pair's 208. The clamp stops
    // the panel at the column so the pair starts at the top (flex-start with
    // zeroed auto margins) and the cards are what overflow into the scrolling
    // drawer column; without it the pair would be centered up over the toolbar.
    const drawerFloor = panelFloor(
      px(declared(DRAWER, '--left-top-floor')),
      px(declared(DRAWER, '--left-bottom-floor')),
    )
    const column = columnFor(320)
    expect(column).toBeLessThan(drawerFloor)
    expect(panelFor(column, drawerFloor)).toBe(column)

    // A drawer column that can hold the pair keeps the floor and never clamps.
    expect(panelFor(columnFor(390), drawerFloor)).toBe(drawerFloor)
  })

  it('fits the drawer floors in the drawer column', () => {
    // The drawer lowers both floors: its column is the viewport less the app
    // header, the editor toolbar and its insets, 232px in the part editor on an
    // 844x390 landscape phone (236px in the assembly, whose toolbar is 4px
    // shorter). A header plus one row is 74px, so each 96px floor has 22px to
    // spare, the pair with the gap is 208px, and the lists scroll under their
    // headers.
    const top = px(declared(DRAWER, '--left-top-floor'))
    const bottom = px(declared(DRAWER, '--left-bottom-floor'))
    const headerFloor = px(declared('.sidebar-header', 'min-height'))
    // The shorthand's first value is the block edge; the bottom edge is 0.
    const headerPad = Number.parseFloat(declared('.sidebar-header', 'padding'))
    expect(headerFloor).toBe(28)
    // The floor already covers the header's 4px top padding (its bottom padding
    // is zero), so header plus one row is the bound the card floors must hold.
    expect(headerFloor).toBeGreaterThanOrEqual(headerPad)
    expect(top).toBe(96)
    expect(bottom).toBe(96)
    expect(top - (headerFloor + rowHeight('.feature-item'))).toBe(22)
    expect(bottom - (headerFloor + rowHeight('.part-item'))).toBe(22)

    const pair = panelFloor(top, bottom)
    expect(pair).toBe(208)
    // The requirement, not the column's exact value: the column moves with the
    // engine's box model, the pair must fit the worst of the two editors.
    expect(pair).toBeLessThanOrEqual(columnFor(390))
    expect(pair).toBeLessThanOrEqual(columnFor(390, ASSEMBLY_TOOLBAR))
    expect(panelFor(columnFor(390), pair)).toBe(pair)

    // A portrait phone's column still affords the reserved share above the
    // floors, so the drawer keeps its third there.
    const portrait = basis(columnFor(667))
    expect(0.34 * portrait).toBeGreaterThan(bottom)
    expect(portrait - 0.34 * portrait - px(token('--left-cards-gap'))).toBeGreaterThan(top)
  })
})
