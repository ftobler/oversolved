// The editors show exactly one Save: the toolbar's, left of the header. It
// carries the unsaved state as a tint (no dot, no second header button), and
// clicking it clears dirty through the same path Ctrl+S and "Save & Exit" take.
// Rendered with the real AppHeader, since the duplicate lived in the header.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import PartToolbar from '@/pages/PartToolbar'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

vi.mock('@/utils/core/commandRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/core/commandRegistry')>()),
  executeCommand: vi.fn(),
}))

function renderToolbar(Toolbar: typeof PartToolbar, handleSave: () => Promise<boolean>) {
  return render(
    <MemoryRouter initialEntries={['/workspaces/w/doc']}>
      <Toolbar docName="Doc" onRename={vi.fn()} handleSave={handleSave} handleClone={vi.fn()} />
    </MemoryRouter>,
  )
}

const saveButtons = () => screen.queryAllByRole('button', { name: /save/i })

function reset() {
  act(() => {
    useUnsavedChangesStore.getState().setDirty(false)
    useUnsavedChangesStore.getState().setSaveHandler(null)
    useUnsavedChangesStore.getState().dismissConfirm()
  })
}

describe.each([
  ['part editor', PartToolbar],
  ['assembly editor', AssemblyToolbar],
])('%s Save button', (_name, Toolbar) => {
  beforeEach(reset)
  afterEach(reset)

  it('is the only Save, and is not tinted while clean', () => {
    const { container } = renderToolbar(Toolbar, vi.fn(async () => true))
    expect(saveButtons()).toHaveLength(1)
    expect(saveButtons()[0].getAttribute('data-dirty')).toBeNull()
    expect(saveButtons()[0].classList.contains('dirty')).toBe(false)
    expect(saveButtons()[0].getAttribute('title')).toBe('Save')
    expect(container.querySelector('.header-dirty-dot')).toBeNull()
  })

  it('stays the only Save when dirty, tinted, with no dot', () => {
    const save = vi.fn(async () => true)
    act(() => {
      useUnsavedChangesStore.getState().setSaveHandler(save)
      useUnsavedChangesStore.getState().setDirty(true)
    })
    const { container } = renderToolbar(Toolbar, save)
    expect(saveButtons()).toHaveLength(1)
    const button = saveButtons()[0]
    expect(button.getAttribute('aria-label')).toBe('Save')
    expect(button.getAttribute('data-dirty')).toBe('true')
    expect(button.classList.contains('dirty')).toBe(true)
    expect(button.getAttribute('title')).toBe('Save (unsaved changes)')
    expect(container.querySelector('.header-dirty-dot')).toBeNull()
    expect(container.querySelector('.workspace-dirty')).toBeNull()
  })

  it('clicking it saves, clears dirty and drops the tint', async () => {
    const save = vi.fn(async () => true)
    act(() => { useUnsavedChangesStore.getState().setDirty(true) })
    renderToolbar(Toolbar, save)

    await act(async () => { fireEvent.click(saveButtons()[0]) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(saveButtons()).toHaveLength(1)
    expect(saveButtons()[0].getAttribute('data-dirty')).toBeNull()
  })

  it('a failed save keeps dirty and the tint', async () => {
    const save = vi.fn(async () => false)
    act(() => { useUnsavedChangesStore.getState().setDirty(true) })
    renderToolbar(Toolbar, save)

    await act(async () => { fireEvent.click(saveButtons()[0]) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    expect(saveButtons()[0].getAttribute('data-dirty')).toBe('true')
  })
})
