// The verdict-button rules moved out of pages/Part.css into the shared
// Glass.css so a dialog shown from either editor (and any future card) can use
// them without importing a page stylesheet. jsdom applies no stylesheet, so
// this reads the files.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const GLASS_CSS = readFileSync(join(__dirname, '../Glass.css'), 'utf8')
const PART_CSS = readFileSync(join(__dirname, '../../../pages/Part.css'), 'utf8')

describe('the shared verdict buttons', () => {
  it('defines the pair and a neutral variant in Glass.css', () => {
    expect(GLASS_CSS).toMatch(/\.feature-ok-btn[^{]*\{[^}]*background:\s*#1a3a1a/)
    expect(GLASS_CSS).toMatch(/\.feature-cancel-btn[^{]*\{[^}]*background:\s*#3a1a1a/)
    expect(GLASS_CSS).toMatch(/\.feature-neutral-btn[^{]*\{[^}]*background:\s*none/)
    // The card's header size and icon size are part of the shared rule, so a
    // dialog button reads at the same 28px / 20px.
    const verdicts = /\.feature-ok-btn,[\s\S]*?\.feature-neutral-btn\s*\{([^}]*)\}/.exec(GLASS_CSS)![0]
    expect(verdicts).toMatch(/width:\s*28px/)
    expect(verdicts).toMatch(/height:\s*28px/)
    expect(verdicts).toContain('.feature-neutral-btn')
  })

  it('leaves Part.css not defining them at all', () => {
    for (const selector of ['.feature-ok-btn', '.feature-cancel-btn', '.feature-rename-btn', '.feature-neutral-btn']) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).test(PART_CSS), selector).toBe(false)
    }
  })

  it('keeps the field primitives the dialog uses out of Part.css too', () => {
    for (const selector of ['.feature-icon', '.feature-field-label', '.feature-field-input', '.field-unit-box', '.field-unit']) {
      expect(GLASS_CSS, selector).toContain(`${selector} {`)
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).test(PART_CSS), selector).toBe(false)
    }
  })
})
