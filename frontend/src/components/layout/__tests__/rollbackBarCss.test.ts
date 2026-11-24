// jsdom applies no stylesheet, so the rollback bar's look is pinned against the
// stylesheets themselves. Part.css owns the bar and the shared row hover rules;
// Assembly.css owns the only frosted hover variant that can mask a row tint.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PART_CSS = readFileSync(join(__dirname, '../../../pages/Part.css'), 'utf8')
const ASSEMBLY_CSS = readFileSync(join(__dirname, '../../../pages/Assembly.css'), 'utf8')
const BLUE = '#4fc3f7'
const NO_HOVER_GATE = ':where(.features-list:not(.features-list--dragging))'

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`missing CSS rule: ${selector}`)
  return match[1]
}

function barRules(css: string): string[] {
  const blocks = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...blocks.matchAll(/(?:^|\n)([^{}\n]*\.rollback-bar[^{}\n]*)\{([^}]*)\}/g)]
    .map(m => m[2])
}

describe('rollback bar styling', () => {
  it('draws the wave from currentColor through a tiling mask', () => {
    const base = ruleBody(PART_CSS, '.rollback-bar')
    expect(base).toMatch(/mask-image:\s*var\(--tiling-sine\)/)
    expect(base).toMatch(/background-color:\s*currentColor/)
    expect(base).not.toMatch(/(?:^|;)\s*background:\s*var\(--tiling-sine\)/)
  })

  it('turns the wave blue on hover and while grabbed, without a box', () => {
    for (const selector of ['.rollback-bar:hover', '.rollback-bar.dragging']) {
      const body = ruleBody(PART_CSS, selector)
      expect(body).toMatch(new RegExp(`color:\\s*${BLUE}\\b`))
      expect(body).not.toMatch(/background(?:-color)?\s*:/)
      expect(body).not.toMatch(/opacity\s*:/)
      expect(body).not.toMatch(/border(?:-[a-z]+)?-color\s*:/)
    }
  })

  it('keeps a disabled bar grey and still, including on hover', () => {
    const disabled = ruleBody(PART_CSS, '.rollback-bar[aria-disabled="true"]')
    expect(disabled).toMatch(/cursor:\s*default/)
    const hover = ruleBody(PART_CSS, '.rollback-bar[aria-disabled="true"]:hover')
    expect(hover).toMatch(/color:\s*gray/)
  })

  it('never paints a box, fades or borders the bar in either stylesheet', () => {
    for (const css of [PART_CSS, ASSEMBLY_CSS]) {
      for (const body of barRules(css)) {
        expect(body).not.toMatch(/opacity:\s*(?:0\b|0?\.[0-9]+)/)
        expect(body).not.toMatch(/border(?:-[a-z]+)?-color\s*:/)
        for (const bg of body.matchAll(/background(?:-color)?\s*:\s*([^;]+);/g)) {
          expect(bg[1].trim()).toBe('currentColor')
        }
      }
    }
  })

  it('dropped the glass hover box behind the bar', () => {
    expect(PART_CSS).not.toMatch(/\.document-panel\s+\.rollback-bar:hover/)
    expect(ASSEMBLY_CSS).not.toMatch(/rollback-bar/)
  })

  it('gates every feature-row hover rule on no active drag', () => {
    const hoverSelectors = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\n)([^{}]+)\{/g)]
      .flatMap(m => m[1].split(',').map(s => s.trim()))
      .filter(s => s.includes('.feature-item') && s.includes(':hover'))
    for (const css of [PART_CSS, ASSEMBLY_CSS]) {
      const selectors = hoverSelectors(css)
      expect(selectors.length).toBeGreaterThan(0)
      for (const selector of selectors) {
        expect(selector, selector).toContain(NO_HOVER_GATE)
      }
    }
  })
})
