// jsdom applies no stylesheet, so the header row's alignment is pinned against
// pages/Part.css itself: Rename must join the shared 28px icon-button rule and
// its icon rule, or the third button breaks the OK/Cancel row.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PART_CSS = readFileSync(join(__dirname, '../../../pages/Part.css'), 'utf8')

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = PART_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in pages/Part.css`).not.toBeNull()
  return match![1]
}

describe('edit card header rename button', () => {
  it('joins the shared 28px icon-button row', () => {
    const buttons = /\.feature-edit-btn,[\s\S]*?\.part-context-btn\s*\{([^}]*)\}/.exec(PART_CSS)![0]
    expect(buttons).toContain('.feature-rename-btn')
    expect(buttons).toMatch(/width:\s*28px/)
    expect(buttons).toMatch(/height:\s*28px/)
  })

  it('joins the shared 20px icon rule', () => {
    const icons = /\.feature-edit-btn img,[\s\S]*?\.part-context-btn img\s*\{([^}]*)\}/.exec(PART_CSS)![0]
    expect(icons).toContain('.feature-rename-btn img')
    expect(icons).toMatch(/width:\s*20px/)
    expect(icons).toMatch(/height:\s*20px/)
  })

  it('reads as a neutral action, not a third verdict', () => {
    const rule = ruleFor('.feature-rename-btn')
    expect(rule).toMatch(/background:\s*none/)
    expect(rule).toMatch(/border-radius:\s*4px/)
    expect(ruleFor('.feature-rename-btn:hover')).toMatch(/background:\s*var\(--glass-hover-bg\)/)
  })
})
