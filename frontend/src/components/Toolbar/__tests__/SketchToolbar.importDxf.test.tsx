// The DXF button borrowed the generic upload glyph and swapped its tooltip for
// an instruction ("Open a sketch to import a DXF") whenever no sketch was open.
// It now carries the toolbar family's picture icon and one fixed name; being
// disabled is the button's own state, never a different sentence.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import SketchToolbar from '@/components/Toolbar/SketchToolbar'
import { iconUrl } from '@/components/Toolbar/tools/toolUtils'
import { CommandRegistryProvider } from '@/contexts/CommandRegistryContext'
import type { CommandTableView } from '@/utils/core/commandSpec'

afterEach(cleanup)

const SRC = join(__dirname, '../../..')

// The toolbar only needs the registry's verdicts and clicks here; the import
// button's own handler is the page callback under assertion.
const registry: CommandTableView = {
  has: () => true,
  enabled: () => true,
  execute: () => ({ ok: true, createdIds: [] }),
}

function renderToolbar(canImportDxf: boolean) {
  const onImportDxf = vi.fn()
  render(
    <CommandRegistryProvider value={registry}>
      <SketchToolbar onResetViewport={vi.fn()} onImportDxf={onImportDxf} canImportDxf={canImportDxf} />
    </CommandRegistryProvider>,
  )
  return { button: screen.getByTitle('Import DXF') as HTMLButtonElement, onImportDxf }
}

describe('SketchToolbar DXF import button', () => {
  it('shows the picture icon, not the shared upload icon', () => {
    const { button } = renderToolbar(true)
    const src = button.querySelector('img')?.getAttribute('src') ?? ''
    // iconUrl answers '' for an unknown name, so a non-empty value also says
    // the generated SVG is in the asset set.
    expect(src).not.toBe('')
    expect(src).toBe(iconUrl('toolbar-import-dxf'))
    expect(src).not.toBe(iconUrl('icon-upload'))
  })

  it.each([true, false])('is named "Import DXF" with canImportDxf=%s', (canImportDxf) => {
    const { button } = renderToolbar(canImportDxf)
    // ToolbarButton copies the title onto the image alt, so both name the
    // action and neither explains the disabled state.
    expect(button.title).toBe('Import DXF')
    expect(button.querySelector('img')?.getAttribute('alt')).toBe('Import DXF')
    expect(button.disabled).toBe(!canImportDxf)
  })

  it('calls onImportDxf only while a sketch is open', () => {
    const open = renderToolbar(true)
    fireEvent.click(open.button)
    expect(open.onImportDxf).toHaveBeenCalledOnce()

    cleanup()

    const closed = renderToolbar(false)
    fireEvent.click(closed.button)
    expect(closed.onImportDxf).not.toHaveBeenCalled()
  })
})

describe('the shared upload icon stays on its other users', () => {
  it('keeps icon-upload.svg in the STEP import and the import feature row', () => {
    const files = [
      'pages/PartToolbar.tsx',
      'pages/AssemblyToolbar.tsx',
      'components/layout/featureIcons.ts',
    ]
    for (const file of files) {
      const text = readFileSync(join(SRC, file), 'utf8')
      expect(text, file).toMatch(/from '@\/assets\/icons\/icon-upload\.svg'/)
    }
  })
})
