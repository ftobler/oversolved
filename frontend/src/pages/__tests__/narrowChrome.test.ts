// The phone-width chrome is CSS, so jsdom cannot paint it. What a test can do
// is hold the rules the layout contract rests on: the navigators hidden below
// the breakpoint and re-shown only by the toolbar toggle's `.panels-open`, the
// toolbars scrolling instead of clipping, and the library rail becoming a
// strip. A regression in any of these brings back the overlapping cards or the
// horizontal scroll this feature removed, and no component test would see it.
//
// The phone breakpoint is a width (portrait) or a height (landscape, where the
// width is a tablet's); both editors key on the same query, so it is asserted
// once here and referenced by the sheets.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '../..')
const PHONE = '(max-width: 768px), (max-height: 480px)'

function cssOf(cssPath: string): string {
  return readFileSync(join(SRC, cssPath), 'utf8')
}

/** The declarations of the first top-level rule whose selector is exactly
 *  `selector`. Indented rules (inside a media query) never match, so a base
 *  rule and its breakpoint override can both be asserted. */
function ruleBody(cssPath: string, selector: string): string {
  const css = cssOf(cssPath)
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in ${cssPath}`).not.toBeNull()
  return match![1]
}

/** The text of one media query's block, matched by balanced braces. */
function mediaBlock(cssPath: string, query: string): string {
  const css = cssOf(cssPath)
  const head = `@media ${query} {`
  const start = css.indexOf(head)
  expect(start, `${head} in ${cssPath}`).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = start + head.length - 1; i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced ${head} in ${cssPath}`)
}

describe('phone-width chrome', () => {
  it('hides both navigators and re-shows each only through the panels toggle', () => {
    const block = mediaBlock('pages/Part.css', PHONE)
    expect(block).toMatch(/\.doc-sidebar,\s*\.floating-left\s*\{\s*display:\s*none/)
    expect(block).toMatch(/\.panels-open \.doc-sidebar\s*\{\s*display:\s*flex/)
    expect(block).toMatch(/\.panels-open \.floating-left\s*\{\s*display:\s*flex/)
  })

  it('keeps the navigator toggle out of the desktop layout', () => {
    expect(ruleBody('pages/Part.css', '.panels-toggle')).toMatch(/display:\s*none/)
    expect(mediaBlock('pages/Part.css', PHONE)).toMatch(/\.panels-toggle\s*\{\s*display:\s*flex/)
  })

  it('turns the editor toolbars into a scroll strip on a phone', () => {
    const block = mediaBlock('pages/Part.css', PHONE)
    expect(block).toMatch(/\.editor-toolbar\s*\{\s*overflow-x:\s*auto/)
    // The strip scrolls, so the one way back to the navigator must not scroll
    // away with it.
    expect(block).toMatch(/\.panels-toggle\s*\{[^}]*position:\s*sticky/)
  })

  it('lets the header give up the wordmark and its side minimums', () => {
    const block = mediaBlock('components/layout/AppHeader.css', '(max-width: 768px)')
    expect(block).toMatch(/\.logo\s*\{\s*display:\s*none/)
    expect(block).toMatch(/\.app-header-left,\s*\.app-header-right\s*\{\s*min-width:\s*0/)
  })

  it('stacks the library rail above the grid instead of beside it', () => {
    const block = mediaBlock('pages/Documents.css', '(max-width: 768px)')
    expect(block).toMatch(/\.documents-layout\s*\{\s*flex-direction:\s*column/)
    expect(block).toMatch(/\.documents-sidebar\s*\{\s*flex-direction:\s*row/)
  })

  it('stacks the docs page list the same way', () => {
    expect(mediaBlock('pages/Docs.css', '(max-width: 768px)'))
      .toMatch(/\.docs-body\s*\{\s*flex-direction:\s*column/)
  })

  it('gives the workspace entry controls their own line on the smallest screens', () => {
    expect(mediaBlock('pages/WorkspaceView.css', '(max-width: 480px)'))
      .toMatch(/\.workspace-entry-row\s*\{\s*flex-wrap:\s*wrap/)
  })
})
