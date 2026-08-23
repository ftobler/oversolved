// handleSaveClick schedules a setTimeout to reset the save icon back to
// "idle"; an unmount before it fires (e.g. switching documents, which fully
// unmounts AssemblyToolbar per DocumentPage.tsx's uuid-keying) must not leave
// it pending to call setState on a torn-down component. Mirrors the
// regression this class of bug already got in PartToolbar.tsx (5209cd17).
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { useAssemblyStore } from '@/stores/assemblyStore'

vi.mock('@/utils/core/commandRegistry', () => ({ executeCommand: vi.fn() }))
vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('AssemblyToolbar save-state reset timer', () => {
  it('clears the pending save-state reset timer on unmount', () => {
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
    const { unmount } = render(
      <AssemblyToolbar
        readOnly={false}
        docName="TestDoc"
        onRename={vi.fn()}
        handleSave={vi.fn()}
        handleClone={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))  // schedules the reset timer

    const clearSpy = vi.spyOn(window, 'clearTimeout')
    unmount()

    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
