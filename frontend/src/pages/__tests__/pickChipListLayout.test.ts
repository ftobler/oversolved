// @vitest-environment node
// The list look is CSS-only, so a DOM test in jsdom cannot see it. Read the two
// sheets that own the chip shell and pin the axis: a second scoped copy in the
// bug report used to bring wrapping back even after Part.css was fixed.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..')

function ruleOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (match === null) throw new Error(`missing rule for ${selector}`)
  return match[1]
}

const SHEETS = [
  ['Part.css', readFileSync(join(SRC, 'pages/Part.css'), 'utf8'), '.feature-pick-chip'],
  ['BugReportPanel.css', readFileSync(join(SRC, 'components/bugReport/BugReportPanel.css'), 'utf8'), '.bug-report-panel .feature-pick-chip'],
] as const

describe('pick chip list layout', () => {
  it.each(SHEETS)('%s stacks chips in a non-wrapping column', (_name, css, selector) => {
    const rule = ruleOf(css, selector)
    expect(rule).toMatch(/flex-direction:\s*column/)
    expect(rule).toMatch(/flex-wrap:\s*nowrap/)
    expect(rule).not.toMatch(/flex-wrap:\s*wrap/)
  })

  it.each(SHEETS)('%s caps the list height so it scrolls instead of growing the form', (_name, css, selector) => {
    const rule = ruleOf(css, selector)
    expect(rule).toMatch(/max-height:\s*150px/)
    expect(rule).toMatch(/overflow-y:\s*auto/)
  })
})
