// The phone-width chrome is CSS, so jsdom cannot paint it. What a test can do
// is resolve the sheets the way a browser would: parse them, match each rule
// against the element a pin is about, and read the declaration that actually
// wins. The pins then hold effective values, so a later competing rule (a
// second `.floating-left { display: flex }`, a re-clipped toolbar, a re-shown
// toggle) fails them instead of hiding behind an earlier rule that still reads
// right, while a selector-group reorder or a reordered declaration does not.
//
// Scope: class-only selectors and the plain descendant space, which is what
// every rule these pins rest on is written with. A rule that reaches one of the
// pinned elements through another form (a pseudo-class, another combinator, an
// attribute test, a tag-qualified compound such as `div.x`, `!important`, a
// non-media at-rule) is skipped rather than guessed at, so extend the matcher
// before writing one of those.
//
// Each pin is read in the contexts it names: the top-level rules (a window
// above the breakpoint, and a landscape phone's chrome) and/or the narrow
// blocks (a 375px portrait phone).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '../..')

/** The editors' phone breakpoint: portrait width, or landscape height. */
const PHONE = '(max-width: 768px), (max-height: 480px)'
/** The width-only narrow block the app chrome keys on. */
const NARROW_WIDTH = '(max-width: 768px)'
/** The tightest block: one column of tiles, wrapped entry rows. */
const SMALL = '(max-width: 480px)'
/** The top level alone: a window above the breakpoint. */
const TOP_LEVEL: readonly string[] = []
/** A 375px-wide portrait phone: every narrow block applies. */
const PORTRAIT: readonly string[] = [PHONE, NARROW_WIDTH, SMALL]
/** A narrow window in general, phone or desktop: the width-only blocks. */
const NARROW: readonly string[] = [NARROW_WIDTH, SMALL]

interface Declaration {
  prop: string
  value: string
}

interface CssRule {
  // One entry per selector of the rule's selector list.
  selectors: string[]
  declarations: Declaration[]
  // The enclosing `@media` query, or null at the top level.
  media: string | null
  // Source order within the sheet; equal-specificity ties go to the later.
  order: number
}

const parsed = new Map<string, CssRule[]>()

function sheet(cssPath: string): CssRule[] {
  const cached = parsed.get(cssPath)
  if (cached) return cached
  const rules = parseRules(readFileSync(join(SRC, cssPath), 'utf8'))
  parsed.set(cssPath, rules)
  return rules
}

/** The index of the `}` matching the `{` at `open`. */
function matchingBrace(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('unbalanced braces')
}

/** Splits a declaration block on `;`, ignoring separators inside quotes or
 *  parentheses (the sheet's inline SVG carries both). */
function splitDeclarations(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ';' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

/** Every flat rule of a sheet in source order, each tagged with its media
 *  query. Non-media at-rules (the one @keyframes) are skipped whole. */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  const walk = (text: string, media: string | null) => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open === -1) break
      const head = text.slice(i, open).trim()
      const close = matchingBrace(text, open)
      if (head.startsWith('@media')) {
        walk(text.slice(open + 1, close), head.slice('@media'.length).trim())
      } else if (!head.startsWith('@')) {
        rules.push({
          selectors: head.split(',').map(s => s.trim()).filter(Boolean),
          declarations: splitDeclarations(text.slice(open + 1, close)).map(part => {
            const colon = part.indexOf(':')
            return { prop: part.slice(0, colon).trim(), value: part.slice(colon + 1).trim() }
          }),
          media,
          order: rules.length,
        })
      }
      i = close + 1
    }
  }
  // Comments can carry selector text (this sheet's do) and must not reach the
  // parser's selector lists.
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), null)
  return rules
}

/** The class list of a class-only compound selector (`.a.b`), or null for a
 *  form the matcher does not read. */
function classesOf(compound: string): string[] | null {
  if (!compound.startsWith('.')) return null
  const classes = compound.split('.').filter(Boolean)
  return classes.every(c => /^[A-Za-z0-9_-]+$/.test(c)) ? classes : null
}

/** Whether a selector matches the element at `chain` (its class list, then its
 *  ancestors', outermost first), or null when the selector's form is out of the
 *  matcher's scope. */
function matches(selector: string, chain: string[][]): boolean | null {
  const compounds: string[][] = []
  for (const part of selector.split(/\s+/).filter(Boolean)) {
    const classes = classesOf(part)
    if (!classes) return null
    compounds.push(classes)
  }
  const isOn = (layer: string[] | undefined, classes: string[]) =>
    layer !== undefined && classes.every(c => layer.includes(c))
  let at = chain.length - 1
  if (!isOn(chain[at], compounds[compounds.length - 1])) return false
  at -= 1
  for (let i = compounds.length - 2; i >= 0; i--) {
    let found = false
    while (at >= 0) {
      if (isOn(chain[at], compounds[i])) {
        found = true
        at -= 1
        break
      }
      at -= 1
    }
    if (!found) return false
  }
  return true
}

/** An element as the matcher sees it: its own class list, then its ancestors',
 *  outermost first. */
function chain(...layers: string[]): string[][] {
  return layers.map(layer => layer.split(' '))
}

/** The value `prop` effectively takes on the element at `chain` when `active`
 *  media blocks are in play (the top level always is), or null when no rule in
 *  play declares it. */
function effective(cssPath: string, prop: string, element: string[][], active: readonly string[]): string | null {
  let winner: { weight: number; order: number; value: string } | null = null
  for (const rule of sheet(cssPath)) {
    if (rule.media !== null && !active.includes(rule.media)) continue
    for (const selector of rule.selectors) {
      // Cheap filter first: a rule that does not name any of the element's
      // classes cannot reach it.
      if (!element.some(layer => layer.some(c => selector.includes(`.${c}`)))) continue
      if (matches(selector, element) !== true) continue
      for (const declaration of rule.declarations) {
        if (declaration.prop !== prop) continue
        const weight = selector.split('.').length - 1
        if (!winner || weight > winner.weight || (weight === winner.weight && rule.order >= winner.order)) {
          winner = { weight, order: rule.order, value: declaration.value }
        }
      }
    }
  }
  return winner?.value ?? null
}

/** `effective`, failing loudly when the property has no declaration in play. */
function pinned(cssPath: string, prop: string, element: string[][], active: readonly string[]): string {
  const value = effective(cssPath, prop, element, active)
  const name = element[element.length - 1].join('.')
  expect(value, `no ${prop} declaration reaches .${name} in ${cssPath}`).not.toBeNull()
  return value!
}

const partCards = chain('doc-container', 'doc-editor', 'viewport-stage', 'floating-left')
const partCardsOpen = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'floating-left')
const editCard = chain('doc-container', 'doc-editor', 'viewport-stage', 'floating-right')
const assemblyTree = chain('doc-container', 'doc-sidebar')
const assemblyTreeOpen = chain('doc-container panels-open', 'doc-sidebar')
const toolbar = chain('doc-container', 'doc-editor', 'editor-toolbar')
const toggle = chain('doc-container', 'doc-editor', 'editor-toolbar', 'editor-btn panels-toggle')

describe('phone-width chrome', () => {
  it('hides each navigator on a phone and re-shows it only through the panels toggle', () => {
    expect(pinned('pages/Part.css', 'display', partCards, PORTRAIT)).toBe('none')
    expect(pinned('pages/Part.css', 'display', assemblyTree, PORTRAIT)).toBe('none')
    expect(pinned('pages/Part.css', 'display', partCardsOpen, PORTRAIT)).toBe('flex')
    expect(pinned('pages/Part.css', 'display', assemblyTreeOpen, PORTRAIT)).toBe('flex')
  })

  it('leaves the navigators and the toolbar alone above the breakpoint', () => {
    const css = 'pages/Part.css'
    expect(pinned(css, 'display', partCards, TOP_LEVEL)).toBe('flex')
    expect(pinned(css, 'display', assemblyTree, TOP_LEVEL)).toBe('flex')
    // The toggle is a phone control; on the desktop it must not even render.
    expect(pinned(css, 'display', toggle, TOP_LEVEL)).toBe('none')
    expect(pinned(css, 'display', toggle, PORTRAIT)).toBe('flex')
  })

  it('narrows the edit card on a phone and keeps its desktop width', () => {
    expect(pinned('pages/Part.css', 'width', editCard, PORTRAIT)).toBe('240px')
    expect(pinned('pages/Part.css', 'width', editCard, TOP_LEVEL)).toBe('300px')
  })

  it('lets both right cards share the phone disclosure slot by scrolling the stack', () => {
    const stack = chain('doc-container', 'doc-editor', 'viewport-stage', 'floating-right', 'right-overlay-stack')
    expect(pinned('pages/Part.css', 'overflow-y', stack, PORTRAIT)).toBe('auto')
    // Above the breakpoint the cards sit in the full-height column; there is
    // no disclosure slot to scroll, so the rule must stay phone-only.
    expect(effective('pages/Part.css', 'overflow-y', stack, TOP_LEVEL)).toBeNull()
  })

  it('turns the editor toolbar into a scroll strip on a phone', () => {
    expect(pinned('pages/Part.css', 'overflow-x', toolbar, PORTRAIT)).toBe('auto')
    expect(pinned('pages/Part.css', 'overflow-x', toolbar, TOP_LEVEL)).toBe('hidden')
    // The strip scrolls, so the one way back to the navigator must not scroll
    // away with it.
    expect(pinned('pages/Part.css', 'position', toggle, PORTRAIT)).toBe('sticky')
  })

  it('lets the header give up the wordmark and its side minimums', () => {
    const css = 'components/layout/AppHeader.css'
    expect(pinned(css, 'display', chain('app-header', 'app-header-left', 'logo'), NARROW)).toBe('none')
    expect(pinned(css, 'min-width', chain('app-header', 'app-header-left'), NARROW)).toBe('0')
    expect(pinned(css, 'min-width', chain('app-header', 'app-header-right'), NARROW)).toBe('0')
    // Above the breakpoint nothing hides the wordmark and the floors stand.
    expect(effective(css, 'display', chain('app-header', 'app-header-left', 'logo'), TOP_LEVEL)).toBeNull()
    expect(pinned(css, 'min-width', chain('app-header', 'app-header-left'), TOP_LEVEL)).toBe('200px')
    expect(pinned(css, 'min-width', chain('app-header', 'app-header-right'), TOP_LEVEL)).toBe('100px')
  })

  it('drops the document separator on a phone and trims the trail for the extra buttons', () => {
    const css = 'components/layout/AppHeader.css'
    const separator = chain('app-header has-file-actions', 'app-header-left', 'app-header-separator')
    const plainSeparator = chain('app-header', 'app-header-left', 'app-header-separator')
    const crumb = chain('app-header has-file-actions', 'app-header-left', 'breadcrumb', 'breadcrumb-crumb')
    const current = chain('app-header has-file-actions', 'app-header-left', 'breadcrumb', 'breadcrumb-current')
    const plainCrumb = chain('app-header', 'app-header-left', 'breadcrumb', 'breadcrumb-crumb')
    const plainCurrent = chain('app-header', 'app-header-left', 'breadcrumb', 'breadcrumb-current')

    // The two file buttons still read as the document group after Clone; the
    // divider is the chrome that goes first when the row runs out of width.
    expect(pinned(css, 'display', separator, NARROW)).toBe('none')
    expect(effective(css, 'display', separator, TOP_LEVEL)).toBeNull()

    // The trail concedes width before the buttons do, at both narrow steps.
    expect(pinned(css, 'max-width', crumb, [NARROW_WIDTH])).toBe('70px')
    expect(pinned(css, 'max-width', current, [NARROW_WIDTH])).toBe('120px')
    expect(pinned(css, 'max-width', crumb, NARROW)).toBe('40px')
    expect(pinned(css, 'max-width', current, NARROW)).toBe('80px')

    // A header without the document group (the workspace pages) keeps the
    // wider caps and never hides a divider it does not render.
    expect(effective(css, 'display', plainSeparator, NARROW)).toBeNull()
    expect(pinned(css, 'max-width', plainCrumb, [NARROW_WIDTH])).toBe('90px')
    expect(pinned(css, 'max-width', plainCurrent, [NARROW_WIDTH])).toBe('160px')
    expect(pinned(css, 'max-width', plainCrumb, NARROW)).toBe('60px')
    expect(pinned(css, 'max-width', plainCurrent, NARROW)).toBe('110px')
  })

  it('stacks the library rail above the grid instead of beside it', () => {
    const css = 'pages/Documents.css'
    expect(pinned(css, 'flex-direction', chain('documents-layout'), NARROW)).toBe('column')
    expect(pinned(css, 'flex-direction', chain('documents-layout', 'documents-sidebar'), NARROW)).toBe('row')
    expect(pinned(css, 'flex-direction', chain('documents-layout', 'documents-sidebar'), TOP_LEVEL)).toBe('column')
  })

  it('stacks the docs page list the same way', () => {
    expect(pinned('pages/Docs.css', 'flex-direction', chain('docs', 'docs-body'), NARROW)).toBe('column')
  })

  it('stacks the registry section list the same way', () => {
    expect(pinned('pages/Registry.css', 'flex-direction', chain('registry-page', 'reg-container'), NARROW)).toBe('column')
  })

  it('gives the workspace entry controls their own line on the smallest screens', () => {
    const css = 'pages/WorkspaceView.css'
    const row = chain('workspace-layout', 'workspace-entries', 'workspace-entry-list', 'workspace-entry-row')
    expect(pinned(css, 'flex-wrap', row, PORTRAIT)).toBe('wrap')
    expect(effective(css, 'flex-wrap', row, TOP_LEVEL)).toBeNull()
  })

  it('keeps the neighbour overlap off the panels toggle', () => {
    // The one toolbar rule that pulls neighbours together by -8px. The toggle
    // is the first button in both toolbars and carries an opaque background on
    // a phone, so the button after it must be excluded from the pull. The rule
    // is a `+` selector, which the matcher above does not read, so the pin is
    // the rule text itself.
    const pulls = sheet('pages/Part.css')
      .flatMap(rule => rule.selectors.map(selector => ({ selector, rule })))
      .filter(({ selector }) => selector.includes('editor-btn'))
      .filter(({ rule }) => rule.declarations.some(d => d.prop === 'margin-left' && d.value === '-8px'))
    expect(pulls).toHaveLength(1)
    expect(pulls[0].selector).toContain(':not(.panels-toggle)')
    // The pin above is keyed on `.editor-btn`, so a pull re-added from the
    // toggle's own side (`.panels-toggle + button { margin-left: -8px }`) would
    // slip past it; the toggle's selectors must declare no negative pull.
    const togglePulls = sheet('pages/Part.css')
      .flatMap(rule => rule.selectors.map(selector => ({ selector, rule })))
      .filter(({ selector }) => selector.startsWith('.panels-toggle'))
      .flatMap(({ selector, rule }) => rule.declarations
        .filter(d => d.prop === 'margin-left' && d.value.startsWith('-'))
        .map(d => `${selector} { margin-left: ${d.value} }`))
    expect(togglePulls).toEqual([])
  })
})
