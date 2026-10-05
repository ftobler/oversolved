// The undo/redo pair sits in one wrapper so its tooltips can anchor to it. The
// wrapper is a single flex child of the header side, so the side's gap spaces
// it from its neighbours but not the two buttons inside it; the wrapper has to
// restate the gap itself. jsdom applies no stylesheet, so the structure is
// checked by rendering and the rule by reading the CSS source.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import PartToolbar from '@/pages/PartToolbar'
import AssemblyToolbar from '@/pages/AssemblyToolbar'

vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const SRC = join(__dirname, '../..')

// The declarations of the first rule whose selector is exactly `selector`.
function ruleBody(cssPath: string, selector: string): string {
  const css = readFileSync(join(SRC, cssPath), 'utf8')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule in ${cssPath}`).not.toBeNull()
  return match![1]
}

describe('undo/redo button spacing', () => {
  it.each([
    ['PartToolbar', PartToolbar],
    ['AssemblyToolbar', AssemblyToolbar],
  ])('%s wraps undo and redo in the one group', (_name, Toolbar) => {
    render(<Toolbar docName="Doc" onRename={vi.fn()} handleSave={vi.fn()} handleClone={vi.fn()} />)
    const undo = screen.getByRole('button', { name: 'Undo' })
    const redo = screen.getByRole('button', { name: 'Redo' })
    expect(undo.parentElement).toBe(redo.parentElement)
    expect(undo.parentElement?.classList.contains('undo-redo-btn-group')).toBe(true)
  })

  it('the group spaces its buttons with the header gap', () => {
    const group = ruleBody('pages/Part.css', '.undo-redo-btn-group')
    expect(group).toMatch(/gap:\s*var\(--toolbar-gap\)/)
    // The tooltips are absolutely positioned against the group.
    expect(group).toMatch(/position:\s*relative/)
  })

  it('the header defines the gap once and both sides use it', () => {
    expect(ruleBody('components/layout/AppHeader.css', '.app-header')).toMatch(/--toolbar-gap:\s*\d+px/)
    expect(ruleBody('components/layout/AppHeader.css', '.app-header-left')).toMatch(/gap:\s*var\(--toolbar-gap\)/)
    expect(ruleBody('components/layout/AppHeader.css', '.app-header-right')).toMatch(/gap:\s*var\(--toolbar-gap\)/)
  })
})
