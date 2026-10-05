// The toolbar's SaveButton schedules a setTimeout to reset the save icon back to
// "idle" once the awaited save resolves; an unmount before it fires (e.g.
// switching documents, which fully unmounts AssemblyToolbar per
// DocumentPage.tsx's uuid-keying) must not leave it pending to call setState
// on a torn-down component. Mirrors the regression this class of bug already
// got in PartToolbar.tsx (5209cd17).
//
// The old file asserted that a global clearTimeout was called on unmount, which
// proves nothing about a save that resolves AFTER the unmount: that resolve
// must not schedule a timer at all. This drives the actual guard.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { deferred } from '@/__tests__/fixtures'

vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

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

describe('AssemblyToolbar save-state reset timer', () => {
  it('a save resolving after unmount schedules no reset timer', async () => {
    vi.useFakeTimers()
    try {
      useAssemblyStore.setState({ undoStack: [], redoStack: [] })
      const gate = deferred()
      const { unmount } = renderToolbar(() => gate.promise)

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      unmount()
      // Whatever React already had queued, the post-unmount resolve must add
      // nothing: a reset timer scheduled here would later setState on a gone
      // component.
      const pendingBefore = vi.getTimerCount()
      await act(async () => { gate.resolve(true) })

      expect(vi.getTimerCount()).toBe(pendingBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('while mounted, the success check resets to the save icon after the timeout', async () => {
    vi.useFakeTimers()
    try {
      useAssemblyStore.setState({ undoStack: [], redoStack: [] })
      const gate = deferred()
      renderToolbar(() => gate.promise)

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await act(async () => { gate.resolve(true) })
      expect(saveIcon()).toBe('check')

      await act(async () => { vi.advanceTimersByTime(1500) })
      expect(saveIcon()).toBe('save')
    } finally {
      vi.useRealTimers()
    }
  })
})
