// The phone-width chrome is CSS, so jsdom cannot paint it. What a test can do
// is resolve the sheets the way a browser would: parse them, match each rule
// against the element a pin is about, and read the declaration that actually
// wins. The pins then hold effective values, so a later competing rule (a
// second `.floating-left { display: flex }`, a re-clipped toolbar, a re-shown
// toggle) fails them instead of hiding behind an earlier rule that still reads
// right, while a selector-group reorder or a reordered declaration does not.
//
// Scope: class-only selectors with the plain descendant space and the child
// combinator (`>`), which covers every rule these pins rest on. A rule that
// reaches one of the pinned elements through another form (a pseudo-class,
// another combinator, an attribute test, a tag-qualified compound such as
// `div.x`, `!important`, a non-media at-rule) is skipped rather than guessed
// at, so extend the matcher before writing one of those.
//
// Each pin is read in the contexts it names: the top-level rules (a window
// above the breakpoint, and a landscape phone's chrome) and/or the narrow
// blocks (a 375px portrait phone).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { GIZMO_SIZE } from '@/components/misc/CubeGizmo.utils'

const SRC = join(__dirname, '../..')

/** The editors' phone breakpoint: portrait width, or landscape height. */
const PHONE = '(max-width: 768px), (max-height: 480px)'
/** The width-only narrow block the app chrome keys on. */
const NARROW_WIDTH = '(max-width: 768px)'
/** The tightest block: one column of tiles, wrapped entry rows. */
const SMALL = '(max-width: 480px)'
/** The workspace entry row's own wrap block (a row needs 200px of controls, so
 *  it wraps before the phone breakpoint does). */
const ENTRY_ROW_WRAP = '(max-width: 560px)'
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
function splitDeclarations(part: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < part.length; i++) {
    const char = part[i]
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ';' && depth === 0) {
      parts.push(part.slice(start, i))
      start = i + 1
    }
  }
  parts.push(part.slice(start))
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

/** One compound of a selector, and whether it must sit directly under the
 *  previous one (the child combinator). */
interface Step {
  classes: string[]
  child: boolean
}

/** The selector's compounds in source order, or null for a form the matcher
 *  does not read (a trailing or doubled `>` included). */
function stepsOf(selector: string): Step[] | null {
  const steps: Step[] = []
  let child = false
  for (const token of selector.split(/\s+/).filter(Boolean)) {
    if (token === '>') {
      if (steps.length === 0 || child) return null
      child = true
      continue
    }
    const classes = classesOf(token)
    if (!classes) return null
    steps.push({ classes, child })
    child = false
  }
  return steps.length > 0 && !child ? steps : null
}

/** Whether a selector matches the element at `chain` (its class list, then its
 *  ancestors', outermost first), or null when the selector's form is out of the
 *  matcher's scope. */
function matches(selector: string, chain: string[][]): boolean | null {
  const steps = stepsOf(selector)
  if (!steps) return null
  const isOn = (layer: string[] | undefined, classes: string[]) =>
    layer !== undefined && classes.every(c => layer.includes(c))
  let at = chain.length - 1
  if (!isOn(chain[at], steps[steps.length - 1].classes)) return false
  at -= 1
  for (let i = steps.length - 2; i >= 0; i--) {
    const step = steps[i]
    // The combinator sits between this step and the next in source order, so
    // the next step's flag decides how this one has to be reached.
    if (steps[i + 1].child) {
      if (!isOn(chain[at], step.classes)) return false
      at -= 1
      continue
    }
    let found = false
    while (at >= 0) {
      if (isOn(chain[at], step.classes)) {
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
// The assembly editor mounts the same overlay stage and the same left card
// column as the part editor, so these two chains are the same selectors: one
// rule now covers both editors' navigators, and these names keep the pin's
// meaning explicit for each caller.
const assemblyCards = chain('doc-container', 'doc-editor', 'viewport-stage', 'floating-left')
const assemblyCardsOpen = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'floating-left')
const toolbar = chain('doc-container', 'doc-editor', 'editor-toolbar')
const toggle = chain('doc-container', 'doc-editor', 'editor-toolbar', 'editor-btn panels-toggle')

describe('phone-width chrome', () => {
  it('hides each navigator on a phone and re-shows it only through the panels toggle', () => {
    expect(pinned('pages/Part.css', 'display', partCards, PORTRAIT)).toBe('none')
    expect(pinned('pages/Part.css', 'display', assemblyCards, PORTRAIT)).toBe('none')
    expect(pinned('pages/Part.css', 'display', partCardsOpen, PORTRAIT)).toBe('flex')
    expect(pinned('pages/Part.css', 'display', assemblyCardsOpen, PORTRAIT)).toBe('flex')
  })

  it('leaves the left cards height token to the drawer', () => {
    // The drawer re-shows the same card column, so it must inherit the base
    // token instead of restating it. The only media override is the tall
    // desktop's 85% reset, which a phone never reaches.
    const overrides = sheet('pages/Part.css')
      .filter(rule => rule.media !== null)
      .flatMap(rule => rule.declarations
        .filter(declaration => declaration.prop === '--left-cards-height')
        .map(declaration => `${rule.media} { --left-cards-height: ${declaration.value} }`))
    expect(overrides).toEqual(['(min-height: 1200px) { --left-cards-height: 85% }'])
  })

  it('keeps the share, the floors and no cap on the drawer cards', () => {
    // The drawer keeps the base share and the same card rules; only the two
    // floors drop, because its column is the shortest the cards meet. These
    // pins read the winning declaration, so a competing rule (the old 60px
    // floors, a max-height hug) fails them instead of hiding behind a substring
    // somewhere in the sheet.
    const css = 'pages/Part.css'
    const desktopTop = chain('doc-container', 'doc-editor', 'viewport-stage', 'floating-left', 'document-panel', 'sidebar-top glass-panel')
    const desktopBottom = chain('doc-container', 'doc-editor', 'viewport-stage', 'floating-left', 'document-panel', 'sidebar-bottom glass-panel')
    const drawerTop = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'floating-left', 'document-panel', 'sidebar-top glass-panel')
    const drawerBottom = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'floating-left', 'document-panel', 'sidebar-bottom glass-panel')
    const cardPanel = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'floating-left', 'document-panel')
    const drawerColumn = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'floating-left')

    expect(pinned(css, 'flex', desktopTop, TOP_LEVEL)).toBe('1 1 0')
    expect(pinned(css, 'min-height', desktopTop, TOP_LEVEL)).toBe('var(--left-top-floor)')
    expect(pinned(css, 'flex', desktopBottom, TOP_LEVEL)).toBe('0 0 var(--left-bottom-share)')
    expect(pinned(css, 'min-height', desktopBottom, TOP_LEVEL)).toBe('var(--left-bottom-floor)')

    // The drawer keeps the panel's basis and the card rules; only the floors
    // they read change, on the drawer's own column.
    expect(pinned(css, 'flex', cardPanel, PORTRAIT)).toBe('0 1 var(--left-cards-height)')
    expect(pinned(css, 'min-height', drawerTop, PORTRAIT)).toBe('var(--left-top-floor)')
    expect(pinned(css, 'min-height', drawerBottom, PORTRAIT)).toBe('var(--left-bottom-floor)')
    expect(pinned(css, '--left-top-floor', drawerColumn, PORTRAIT)).toBe('96px')
    expect(pinned(css, '--left-bottom-floor', drawerColumn, PORTRAIT)).toBe('96px')
    // Above the breakpoint nothing on the column overrides them: the base
    // values come from :root (pinned as numbers in featureListDensity.test.ts).
    expect(effective(css, '--left-top-floor', partCards, TOP_LEVEL)).toBeNull()

    // One panel rule sums the two floors and the gap in both contexts and
    // clamps the result to the column, so a window shorter than the floors
    // cannot push the pair up over the toolbar.
    const panelFloor = 'min(calc(var(--left-top-floor) + var(--left-bottom-floor) + var(--left-cards-gap)), 100%)'
    expect(pinned(css, 'min-height', cardPanel, PORTRAIT)).toBe(panelFloor)
    expect(pinned(css, 'min-height', cardPanel, TOP_LEVEL)).toBe(panelFloor)
    expect(pinned(css, 'gap', cardPanel, TOP_LEVEL)).toBe('var(--left-cards-gap)')

    // No rule in any sheet that reaches either editor's bottom card may cap it:
    // a max-height (or its logical twin) would bring back the content hug this
    // layout replaced. The assembly card carries `assembly-panel` and its sheet
    // scopes through it, and the cards' shared frost classes also set sizes, so
    // all three sheets are scanned.
    const desktopAssembly = chain('doc-container', 'doc-editor', 'viewport-stage', 'floating-left', 'document-panel', 'sidebar-bottom glass-panel assembly-panel')
    const drawerAssembly = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'floating-left', 'document-panel', 'sidebar-bottom glass-panel assembly-panel')
    const cards = [desktopBottom, drawerBottom, desktopAssembly, drawerAssembly]
    const capped = ['pages/Part.css', 'pages/Assembly.css', 'components/layout/Glass.css'].flatMap(cssPath =>
      sheet(cssPath).filter(rule =>
        rule.declarations.some(declaration =>
          declaration.prop === 'max-height' || declaration.prop === 'max-block-size') &&
        rule.selectors.some(selector => cards.some(card => matches(selector, card) === true))))
    expect(capped).toEqual([])
  })

  it('starts the drawer pair at the top and centres it with auto margins', () => {
    // `safe center` is outside the declared browser floor, so the drawer cannot
    // lean on it: flex-start plus the panel's auto block margins centre the
    // pair while it fits and leave it start-aligned when it does not, with the
    // column scrolling instead of centering the top out of reach.
    const css = 'pages/Part.css'
    const drawerColumn = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'floating-left')
    const cardPanel = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'floating-left', 'document-panel')
    expect(pinned(css, 'justify-content', drawerColumn, PORTRAIT)).toBe('flex-start')
    expect(pinned(css, 'overflow-y', drawerColumn, PORTRAIT)).toBe('auto')
    // The hidden x axis is a deliberate trade: clipping the cards' side shadow
    // on the phone drawer keeps the column scrolling only downwards.
    expect(pinned(css, 'overflow-x', drawerColumn, PORTRAIT)).toBe('hidden')
    expect(pinned(css, 'margin-block', cardPanel, PORTRAIT)).toBe('auto')
    // Above the breakpoint the pair keeps its centred look and no scrollport.
    expect(pinned(css, 'justify-content', partCards, TOP_LEVEL)).toBe('center')
    expect(effective(css, 'overflow-y', partCards, TOP_LEVEL)).toBeNull()
    expect(effective(css, 'margin-block', cardPanel, TOP_LEVEL)).toBeNull()
  })

  it('keeps the chrome heights the card column arithmetic subtracts', () => {
    // featureListDensity.test.ts turns these bars into the card column's
    // height. The parts are pinned here, not only the sums, so a padding or
    // size change fails in the file that owns the layout numbers instead of
    // silently moving the cards three files away. CssBaseline (main.tsx) makes
    // border-box global, so every height below already includes its padding.
    const header = 'components/layout/AppHeader.css'
    const css = 'pages/Part.css'
    const headerPadding = pinned(header, 'padding', chain('app-header'), TOP_LEVEL)
    const headerBorder = pinned(header, 'border-bottom', chain('app-header'), TOP_LEVEL)
    const headerButton = pinned(header, 'height', chain('app-header', 'toolbar-btn'), TOP_LEVEL)
    const toolbarPadding = pinned(css, 'padding', toolbar, TOP_LEVEL)
    const toolbarBorder = pinned(css, 'border-bottom', toolbar, TOP_LEVEL)
    const editorButton = pinned(css, 'height', chain('doc-container', 'doc-editor', 'editor-toolbar', 'editor-btn'), TOP_LEVEL)
    const selectorPadding = pinned(css, 'padding', chain('doc-container', 'doc-editor', 'editor-toolbar', 'mode-selector'), TOP_LEVEL)
    const modeButtonHeight = pinned(css, 'height', chain('doc-container', 'doc-editor', 'editor-toolbar', 'mode-selector', 'mode-btn'), TOP_LEVEL)

    const num = (value: string) => Number.parseFloat(value)
    const bar = (padding: string, border: string, content: number) => 2 * num(padding) + num(border) + content
    expect(bar(headerPadding, headerBorder, num(headerButton))).toBe(53)
    // The mode buttons fill the selector's content box at 40px, and the
    // selector adds its own 2px padding: 44px inside the toolbar's chrome.
    expect(2 * num(selectorPadding) + num(modeButtonHeight)).toBe(44)
    expect(bar(toolbarPadding, toolbarBorder, 44)).toBe(53)
    // The assembly's toolbar has no mode selector: 40px buttons only.
    expect(bar(toolbarPadding, toolbarBorder, num(editorButton))).toBe(49)
  })

  it('leaves the navigators and the toolbar alone above the breakpoint', () => {
    const css = 'pages/Part.css'
    expect(pinned(css, 'display', partCards, TOP_LEVEL)).toBe('flex')
    expect(pinned(css, 'display', assemblyCards, TOP_LEVEL)).toBe('flex')
    // The toggle is a phone control; on the desktop it must not even render.
    expect(pinned(css, 'display', toggle, TOP_LEVEL)).toBe('none')
    expect(pinned(css, 'display', toggle, PORTRAIT)).toBe('flex')
  })

  it('narrows the edit card on a phone and keeps its desktop width', () => {
    expect(pinned('pages/Part.css', 'width', editCard, PORTRAIT)).toBe('240px')
    expect(pinned('pages/Part.css', 'width', editCard, TOP_LEVEL)).toBe('300px')
  })

  it('steps the empty-assembly hint aside only while the phone drawer covers it', () => {
    const hintOpen = chain('doc-container panels-open', 'doc-editor', 'viewport-stage', 'assembly-empty-hint')
    expect(pinned('pages/Assembly.css', 'display', hintOpen, PORTRAIT)).toBe('none')

    // Drawer closed on the same phone: no rule hides the hint, so it keeps the
    // paragraph's default display. This is what tells "hidden while the drawer
    // is open" apart from "hidden on every phone".
    const hintClosed = chain('doc-container', 'doc-editor', 'viewport-stage', 'assembly-empty-hint')
    expect(effective('pages/Assembly.css', 'display', hintClosed, PORTRAIT)).toBeNull()
    // Above the breakpoint there is no drawer to cover it either.
    expect(effective('pages/Assembly.css', 'display', hintClosed, TOP_LEVEL)).toBeNull()
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

  it('gives the workspace search an inset from the wordmark, and none once it is gone', () => {
    // The search group is the page's fill for the header's children slot. The
    // trail and the document name bring their own horizontal inset; the group
    // brings none, so at the button gap it sat hard against the wordmark.
    const css = 'components/layout/AppHeader.css'
    const controls = chain('app-header', 'app-header-left', 'doc-controls')
    expect(pinned(css, 'margin-left', controls, TOP_LEVEL)).toBe('12px')
    // The wordmark is hidden on a phone, so the group follows the burger there
    // and the inset would read as a hole in the row.
    expect(pinned(css, 'margin-left', controls, NARROW)).toBe('0')
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
    // The wrap lives in the row's own block, one rung above the phone
    // breakpoint: five 40px controls do not fit beside the face once the window
    // is that narrow, and the row wraps there rather than at 480.
    expect(pinned(css, 'flex-wrap', row, [...PORTRAIT, ENTRY_ROW_WRAP])).toBe('wrap')
    expect(effective(css, 'flex-wrap', row, TOP_LEVEL)).toBeNull()
  })

  it('reserves bottom clearance for the view options and cube stack', () => {
    // The right panel must clear the stack the viewport puts in the corner:
    // the view options button, the orientation cube, the cube's sink floor and
    // the stack's gap. Every number below is read from the sheet that owns it,
    // so a widget resize that outgrows the clearance fails here instead of
    // letting the panel overlap the cube. The one literal is the intent:
    // 206px of stack plus margin. The measurement readout used to be the
    // bottom item of this stack; it moved to the bottom-left slot, and the
    // floor it left under the cube stayed as padding, so the stack is the same
    // height it was.
    const css = readFileSync(join(SRC, 'pages/Part.css'), 'utf8')
    const clearance = Number(/--hud-clearance:\s*(\d+)px/.exec(css)![1])
    const inset = Number(/--floating-inset:\s*(\d+)px/.exec(css)![1])
    const button = Number(pinned('components/Viewport/ViewOptions.css', 'height', chain('view-options', 'view-options-btn'), TOP_LEVEL)!.replace('px', ''))
    const floor = Number(pinned('components/Viewport/ViewportHud.css', 'padding-bottom', chain('viewport-hud'), TOP_LEVEL)!.replace('px', ''))
    const gap = Number(pinned('components/Viewport/ViewportHud.css', 'gap', chain('viewport-hud'), TOP_LEVEL)!.replace('px', ''))

    const stack = GIZMO_SIZE + button + floor + gap + inset
    expect(clearance).toBe(228)
    expect(clearance).toBeGreaterThanOrEqual(stack)
  })

  it('leaves the measurement readout in the bottom-left, left-aligned', () => {
    // The readout left the right-aligned HUD column for its own corner slot.
    // No rule may re-right-align it: the slot's flex start is the whole rule,
    // and the display keeps the text flow's natural (left) alignment.
    const css = 'components/Viewport/ViewportHud.css'
    const slot = chain('viewport-readout')
    const display = chain('viewport-readout', 'measurement-display')
    expect(pinned(css, 'left', slot, TOP_LEVEL)).toBe('12px')
    expect(pinned(css, 'bottom', slot, TOP_LEVEL)).toBe('12px')
    expect(pinned(css, 'justify-content', slot, TOP_LEVEL)).toBe('flex-start')
    expect(effective(css, 'right', slot, TOP_LEVEL)).toBeNull()
    expect(effective(css, 'text-align', slot, TOP_LEVEL)).toBeNull()
    expect(effective(css, 'text-align', display, TOP_LEVEL)).toBeNull()
    expect(effective(css, 'justify-content', display, TOP_LEVEL)).toBeNull()
  })

  it('keeps the extras disclosure out of the readout row', () => {
    // The slot reserves one row; opening "more" must not grow the readout up
    // into the navigator card's band past --readout-clearance. The panel is
    // absolute above the summary, so the row's height never changes.
    const css = 'components/Viewport/ViewportHud.css'
    const more = chain('viewport-readout', 'measurement-display', 'measurement-more')
    const extras = chain('viewport-readout', 'measurement-display', 'measurement-more', 'measurement-extras')
    expect(pinned(css, 'position', more, TOP_LEVEL)).toBe('relative')
    expect(pinned(css, 'position', extras, TOP_LEVEL)).toBe('absolute')
    expect(pinned(css, 'bottom', extras, TOP_LEVEL)).toBe('calc(100% + 4px)')
    // An author `display` would override the UA rule that hides a closed
    // details' content, so the panel must not declare one.
    expect(effective(css, 'display', extras, TOP_LEVEL)).toBeNull()
  })

  it('bounds the left card column above the bottom-left readout', () => {
    // A tall Features/Parts list must stop above the readout instead of
    // letting its glass card cover the text. The clearance is one 16px
    // readout row plus a 12px gap above the bottom inset.
    const css = readFileSync(join(SRC, 'pages/Part.css'), 'utf8')
    expect(Number(/--readout-clearance:\s*(\d+)px/.exec(css)![1])).toBe(28)
    expect(pinned('pages/Part.css', 'bottom', partCards, TOP_LEVEL))
      .toBe('calc(var(--floating-inset) + var(--readout-clearance))')
    expect(pinned('components/Viewport/ViewportHud.css', 'min-height', chain('viewport-readout'), TOP_LEVEL)).toBe('16px')
  })

  it('turns the view options card into a bottom sheet on a phone', () => {
    const card = chain('view-options', 'view-options-popover')
    expect(pinned('components/Viewport/ViewOptions.css', 'position', card, PORTRAIT)).toBe('fixed')
    expect(pinned('components/Viewport/ViewOptions.css', 'left', card, PORTRAIT)).toBe('0')
    expect(pinned('components/Viewport/ViewOptions.css', 'right', card, PORTRAIT)).toBe('0')
    expect(pinned('components/Viewport/ViewOptions.css', 'bottom', card, PORTRAIT)).toBe('0')
    // Above the breakpoint it stays a popover anchored above the eye button.
    expect(pinned('components/Viewport/ViewOptions.css', 'position', card, TOP_LEVEL)).toBe('absolute')
    expect(pinned('components/Viewport/ViewOptions.css', 'bottom', card, TOP_LEVEL)).toBe('calc(100% + 6px)')
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
