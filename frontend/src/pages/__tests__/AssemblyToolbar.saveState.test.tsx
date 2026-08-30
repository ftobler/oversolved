// Assembly counterpart to PartToolbar.saveState: the saved check flashes only
// when the page's save resolves true, never while in flight and never on a
// failure (the error banner reports failures; the toolbar just stays quiet).
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { useAssemblyStore } from '@/stores/assemblyStore'

vi.mock('@/utils/core/commandRegistry', () => ({ executeCommand: vi.fn() }))
vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function deferred() {
  let resolve!: (saved: boolean) => void
  const promise = new Promise<boolean>(r => { resolve = r })
  return { promise, resolve }
}

function renderToolbar(handleSave: () => Promise<boolean>) {
  return render(
    <AssemblyToolbar
      docName="TestDoc"
      onRename={vi.fn()}
      handleSave={handleSave}
      handleClone={vi.fn()}
    />,
  )
}

const saveIcon = () => screen.getByRole('button', { name: 'Save' }).textContent

describe('AssemblyToolbar save state', () => {
  it('flashes the check only after the save resolves true', async () => {
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
    const gate = deferred()
    renderToolbar(() => gate.promise)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // In flight: still the plain save icon.
    expect(saveIcon()).toBe('save')

    await act(async () => { gate.resolve(true) })
    await waitFor(() => expect(saveIcon()).toBe('check'))
  })

  it('never shows the check when the save resolves false', async () => {
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
    const gate = deferred()
    renderToolbar(() => gate.promise)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await act(async () => { gate.resolve(false) })

    expect(saveIcon()).toBe('save')
  })
})
