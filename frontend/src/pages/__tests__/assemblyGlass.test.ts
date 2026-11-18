// The assembly navigator and its editor now float over the model like the part
// editor's cards, so the colours that were opaque for the old sidebar must be
// alpha twins now, and the sidebar's own chrome must be gone. CSS only: jsdom
// applies no stylesheet, so the sheets are the source of truth.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '../..')
const PART_CSS = readFileSync(join(SRC, 'pages/Part.css'), 'utf8')
const ASSEMBLY_CSS = readFileSync(join(SRC, 'pages/Assembly.css'), 'utf8')

// The declarations of the first rule whose selector is exactly `selector`.
function rulePart(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule`).not.toBeNull()
  return match![1]
}

describe('assembly glass twins', () => {
  it('keeps the related row tint at alpha, leaving the part editor rule alone', () => {
    const related = rulePart(ASSEMBLY_CSS, '.assembly-panel .feature-item.related:not(.selected):not(.editing)')
    expect(related).toMatch(/background:\s*rgba\(18, 32, 40, 0\.55\)/)
    // The shared opaque rule is still the part editor's look.
    expect(rulePart(PART_CSS, '.feature-item.related')).toMatch(/background:\s*#122028/)
  })

  it('keeps a selected related row on the shared selected tint', () => {
    const selected = rulePart(ASSEMBLY_CSS, '.assembly-panel .feature-item.selected.related')
    expect(selected).toMatch(/background:\s*var\(--glass-selected-bg\)/)
  })

  it('keeps the verdict row tints at alpha over the frosted Parts card', () => {
    expect(rulePart(ASSEMBLY_CSS, '.assembly-verdict-error')).toMatch(/background:\s*rgba\(42, 20, 20, 0\.55\)/)
    expect(rulePart(ASSEMBLY_CSS, '.assembly-verdict-warning')).toMatch(/background:\s*rgba\(42, 36, 16, 0\.55\)/)
  })

  it('drops the row divider from the editor bodies now the card header separates them', () => {
    const part = /\.mate-editor,\s*\.instance-editor\s*\{([^}]*)\}/.exec(ASSEMBLY_CSS)![1]
    expect(part).not.toMatch(/border-top|margin-top|padding-top/)
  })

  it('uses the frosted field tint for the mate angle step button', () => {
    const part = /\.mate-angle-buttons button\s*\{([^}]*)\}/.exec(ASSEMBLY_CSS)![1]
    expect(part).toContain('var(--glass-field-bg)')
  })
})

describe('retired sidebar chrome', () => {
  it('has no opaque navigator column or splitter left in the shared sheet', () => {
    expect(PART_CSS).not.toMatch(/(?:^|\n)\.doc-sidebar\s*\{/)
    expect(PART_CSS).not.toMatch(/(?:^|\n)\.resize-handle\b/)
    // No phone rule may re-show a column that no longer exists.
    expect(PART_CSS).not.toMatch(/\.doc-container\.panels-open \.doc-sidebar\b/)
  })

  it('has no absolute assembly viewport host and no old tree wrapper', () => {
    expect(ASSEMBLY_CSS).not.toMatch(/(?:^|\n)\.assembly-viewport-host\b/)
    expect(ASSEMBLY_CSS).not.toMatch(/(?:^|\n)\.assembly-tree\b/)
  })
})
