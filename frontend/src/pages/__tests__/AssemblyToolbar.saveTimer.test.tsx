// handleSaveClick schedules a setTimeout to reset the save icon back to
// "idle" once the awaited save resolves; an unmount before it fires (e.g.
// switching documents, which fully unmounts AssemblyToolbar per
// DocumentPage.tsx's uuid-keying) must not leave it pending to call setState
// on a torn-down component. Mirrors the regression this class of bug already
// got in PartToolbar.tsx (5209cd17).
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { useAssemblyStore } from '@/stores/assemblyStore'

vi.mock('@/utils/core/commandRegistry', () => ({ executeCommand: vi.fn() }))
vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('AssemblyToolbar save-state reset timer', () => {
  it('clears the pending save-state reset timer on unmount', async () => {
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
    const { unmount } = render(
      <AssemblyToolbar
        docName="TestDoc"
        onRename={vi.fn()}
        handleSave={() => Promise.resolve(true)}
        handleClone={vi.fn()}
      />,
    )

    // The reset timer is scheduled only after the awaited save resolves.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })

    const clearSpy = vi.spyOn(window, 'clearTimeout')
    unmount()

    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
