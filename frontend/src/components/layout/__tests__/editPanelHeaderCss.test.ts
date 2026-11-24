// jsdom applies no stylesheet, so the header row's alignment is pinned against
// the stylesheets themselves: the verdict pair and the neutral third button live
// in the shared Glass.css (a dialog must not depend on Part.css), the row itself
// travels with components/shared/CardHeader.tsx in CardHeader.css, and the part
// and assembly pages keep only the tree row's own icon buttons.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PART_CSS = readFileSync(join(__dirname, '../../../pages/Part.css'), 'utf8')
const GLASS_CSS = readFileSync(join(__dirname, '../Glass.css'), 'utf8')
const CARD_HEADER_CSS = readFileSync(join(__dirname, '../CardHeader.css'), 'utf8')

describe('edit card header buttons', () => {
  it('keeps the tree row on the shared 28px icon-button rule', () => {
    const buttons = /\.feature-edit-btn,[\s\S]*?\.part-context-btn\s*\{([^}]*)\}/.exec(PART_CSS)![0]
    expect(buttons).toMatch(/width:\s*28px/)
    expect(buttons).toMatch(/height:\s*28px/)
  })

  it('keeps the tree row on the shared 20px icon rule', () => {
    const icons = /\.feature-edit-btn img,[\s\S]*?\.part-context-btn img\s*\{([^}]*)\}/.exec(PART_CSS)![0]
    expect(icons).toMatch(/width:\s*20px/)
    expect(icons).toMatch(/height:\s*20px/)
  })

  it('puts Rename on the shared verdict row at the verdict size', () => {
    const verdicts = /\.feature-ok-btn,[\s\S]*?\.feature-neutral-btn\s*\{([^}]*)\}/.exec(GLASS_CSS)![0]
    expect(verdicts).toContain('.feature-rename-btn')
    expect(verdicts).toMatch(/width:\s*28px/)
    expect(verdicts).toMatch(/height:\s*28px/)
    expect(GLASS_CSS).toMatch(/\.feature-rename-btn img,[\s\S]*?\{[^}]*width:\s*20px/)
  })

  it('reads Rename as a neutral action, not a third verdict', () => {
    expect(GLASS_CSS).toMatch(
      /\.feature-rename-btn,\s*\n\.feature-neutral-btn\s*\{[^}]*background:\s*none[^}]*border-radius:\s*4px/,
    )
    expect(GLASS_CSS).toMatch(
      /\.feature-rename-btn:hover,\s*\n\.feature-neutral-btn:hover\s*\{[^}]*background:\s*var\(--glass-hover-bg\)/,
    )
  })

  it('keeps the shared header row with the component, out of Part.css', () => {
    expect(CARD_HEADER_CSS).toMatch(/\.card-header\s*\{[^}]*gap:\s*8px/)
    expect(CARD_HEADER_CSS).toMatch(/\.card-header\s*\{[^}]*padding:\s*6px 8px/)
    expect(CARD_HEADER_CSS).toMatch(/\.card-header-title\s*\{[^}]*text-overflow:\s*ellipsis/)
    for (const selector of ['.card-header', '.card-header-title']) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).test(PART_CSS), selector).toBe(false)
    }
  })

  it('keeps a disabled verdict at its size and colour', () => {
    expect(GLASS_CSS).toMatch(/\.feature-ok-btn:disabled[\s\S]*?\{[^}]*cursor:\s*not-allowed/)
  })
})
