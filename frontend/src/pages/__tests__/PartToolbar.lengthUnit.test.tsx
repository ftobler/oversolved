// The document length unit control in the part header. It is a document write
// (one `set_length_unit` mutation), not an export option, so it lives beside the
// other document file actions and follows their open-edit gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import PartToolbar from '@/pages/PartToolbar'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { CommandRegistryProvider } from '@/contexts/CommandRegistryContext'
import { partRegistry } from './commandFixtures'
import type { LengthUnit } from '@/types/cad'

vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function renderToolbar(lengthUnit: LengthUnit = 'mm') {
  const onSetLengthUnit = vi.fn()
  render(
    <CommandRegistryProvider value={partRegistry()}>
      <PartToolbar
        docName="Bracket"
        onRename={vi.fn()}
        handleSave={vi.fn()}
        handleClone={vi.fn()}
        onImport={vi.fn()}
        onExport={vi.fn()}
        lengthUnit={lengthUnit}
        onSetLengthUnit={onSetLengthUnit}
      />
    </CommandRegistryProvider>,
  )
  return { onSetLengthUnit }
}

const unitSelect = () => screen.getByRole('combobox', { name: 'Document length unit' }) as HTMLSelectElement

describe('PartToolbar length unit', () => {
  beforeEach(() => {
    act(() => {
      usePartEditorStore.setState({ undoStack: [], redoStack: [] })
      useEditorState.setState({ editingFeatureId: null })
      useEditorModeStore.getState().setActiveEditor('part')
    })
  })

  afterEach(() => {
    act(() => { useEditorModeStore.getState().setActiveEditor(null) })
  })

  it('shows the document unit: mm by default and in for an inch document', () => {
    renderToolbar('mm')
    expect(unitSelect().value).toBe('mm')
  })

  it('selects the inch option for an inch document and dispatches on change', () => {
    const { onSetLengthUnit } = renderToolbar('inch')
    expect(unitSelect().value).toBe('inch')
    fireEvent.change(unitSelect(), { target: { value: 'mm' } })
    expect(onSetLengthUnit).toHaveBeenCalledWith('mm')
  })

  it('dispatches an inch pick from a millimetre document', () => {
    const { onSetLengthUnit } = renderToolbar('mm')
    fireEvent.change(unitSelect(), { target: { value: 'inch' } })
    expect(onSetLengthUnit).toHaveBeenCalledWith('inch')
  })

  it('is disabled while a feature edit is open, like the file actions', () => {
    renderToolbar('mm')
    act(() => { useEditorState.setState({ editingFeatureId: 'ex1' }) })
    expect(unitSelect().disabled).toBe(true)
    act(() => { useEditorState.setState({ editingFeatureId: null }) })
    expect(unitSelect().disabled).toBe(false)
  })
})
