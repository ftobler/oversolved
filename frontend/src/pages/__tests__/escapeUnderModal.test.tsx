import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import MessageDialog from '@/components/dialogs/MessageDialog'
import Dialog from '@/components/dialogs/Dialog'
import { buildCommandEntries } from '@/pages/commandEntries'
import { registerCommand, clearAllHandlers, dispatchKey } from '@/utils/core/commandRegistry'
import { resetModalEscape } from '@/utils/core/modalEscape'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { initializeTools } from '@/tools'

// The over-cancel bug, end to end. Both dispatchKey and the Dialog shell listen
// for Escape on window, and dispatchKey is attached first (useCommandRegistration
// runs on mount, long before any dialog). So one Escape used to close the dialog
// AND run cancel_draw, destroying an in-flight draw the user never abandoned.
// Repro from the report: arm the line tool, place two points, raise the mirror
// tool's "Not Implemented" message box, press Escape.

const noop = () => {}

function attachDispatch(): () => void {
  for (const e of buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, noop)) {
    registerCommand(e.name, e.fn)
  }
  // Same order as production: the global dispatcher is on window before the
  // dialog mounts, so listener order alone can never protect the draw.
  window.addEventListener('keydown', dispatchKey)
  return () => window.removeEventListener('keydown', dispatchKey)
}

function pressEscape() {
  act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
}

describe('Escape under a modal does not cancel the sketch gesture', () => {
  beforeAll(() => { initializeTools() })

  let detach: () => void

  beforeEach(() => {
    clearAllHandlers()
    resetModalEscape()
    useSketchEditorStore.setState({ pendingDialog: null })
    detach = attachDispatch()
  })

  afterEach(() => {
    detach()
    clearAllHandlers()
    resetModalEscape()
    useSketchEditorStore.getState().setActiveTool(null)
  })

  it('keeps the armed tool and its draw points while a message box is open', () => {
    const onClose = vi.fn()
    useSketchEditorStore.getState().setActiveTool('line')
    useSketchEditorStore.setState({ drawPoints: [[0, 0], [10, 10]] })

    const view = render(
      <MessageDialog isOpen title="Not Implemented" message="Mirror tool is not yet implemented." onClose={onClose} />
    )

    pressEscape()

    // The dialog answered the keystroke; the sketch gesture was not touched.
    expect(onClose).toHaveBeenCalledOnce()
    expect(useSketchEditorStore.getState().activeTool).toBe('line')
    expect(useSketchEditorStore.getState().drawPoints).toHaveLength(2)

    // Closing is the owner's job, and unmounting releases the Escape claim.
    view.unmount()

    pressEscape()

    expect(useSketchEditorStore.getState().activeTool).toBeNull()
    expect(useSketchEditorStore.getState().drawPoints).toHaveLength(0)
    expect(useSketchEditorStore.getState().modeStack).toEqual([])
  })

  it('a busy dialog still holds Escape even though it refuses to close', () => {
    const onClose = vi.fn()
    useSketchEditorStore.getState().setActiveTool('line')
    useSketchEditorStore.setState({ drawPoints: [[0, 0]] })

    // `busy` seals the shell's own exits, so it will not close on Escape. The
    // claim is keyed on isOpen precisely so the global handler cannot reach past
    // a dialog that is still on screen and cancel what raised it.
    render(<Dialog isOpen busy title="Exporting" onClose={onClose}>working</Dialog>)

    pressEscape()

    expect(onClose).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().activeTool).toBe('line')
    expect(useSketchEditorStore.getState().drawPoints).toHaveLength(1)
  })

  it('with no dialog mounted, Escape cancels the gesture as before', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useSketchEditorStore.setState({ drawPoints: [[0, 0], [10, 10]] })

    pressEscape()

    expect(useSketchEditorStore.getState().activeTool).toBeNull()
    expect(useSketchEditorStore.getState().drawPoints).toHaveLength(0)
  })
})
