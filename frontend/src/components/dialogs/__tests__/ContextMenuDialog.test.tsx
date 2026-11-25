import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ContextMenuDialog from '@/components/dialogs/ContextMenuDialog'
import { useSketchUiStore } from '@/stores/sketchEditorStore'
import { registerCommand, clearAllHandlers, dispatchKey } from '@/hooks/commandRegistry'
import { modalOwnsEscape, resetModalEscape } from '@/utils/core/modalEscape'

describe('ContextMenuDialog validation', () => {
  beforeEach(() => {
    useSketchUiStore.setState({
    pendingDialog: null,
  })
  })

  function openWith(onConfirm: (v: string) => void) {
    useSketchUiStore.setState({
    pendingDialog: {
        position: [0, 0],
        label: 'Dimension value',
        defaultValue: '10',
        validate: (v) => (parseFloat(v) > 0 ? null : 'Must be greater than 0'),
        onConfirm,
      },
  })
  }

  it('rejects invalid input: keeps dialog open, shows error, does not confirm', () => {
    const onConfirm = vi.fn()
    openWith(onConfirm)
    render(<ContextMenuDialog />)

    const input = screen.getByDisplayValue('10') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onConfirm).not.toHaveBeenCalled()
    expect(useSketchUiStore.getState().pendingDialog).not.toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Must be greater than 0')
  })

  it('accepts valid input: confirms and closes', () => {
    const onConfirm = vi.fn()
    openWith(onConfirm)
    render(<ContextMenuDialog />)

    const input = screen.getByDisplayValue('10') as HTMLInputElement
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledWith('25')
    expect(useSketchUiStore.getState().pendingDialog).toBeNull()
  })

  it('clears the error once the user edits the input', () => {
    openWith(vi.fn())
    render(<ContextMenuDialog />)

    const input = screen.getByDisplayValue('10') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('alert')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '3' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders the extra action (Flip side) and runs it without validation, then closes', () => {
    const onConfirm = vi.fn()
    const onFlip = vi.fn()
    useSketchUiStore.setState({
    pendingDialog: {
        position: [0, 0],
        label: 'Dimension value',
        defaultValue: '10',
        validate: () => 'always invalid',  // proves the flip path skips validation
        onConfirm,
        extraAction: { label: 'Flip side', onClick: onFlip },
      },
  })
    render(<ContextMenuDialog />)

    fireEvent.click(screen.getByText('Flip side'))

    expect(onFlip).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(useSketchUiStore.getState().pendingDialog).toBeNull()
  })

  it('omits the extra action button when none is provided', () => {
    openWith(vi.fn())
    render(<ContextMenuDialog />)
    expect(screen.queryByText('Flip side')).not.toBeInTheDocument()
  })

  it('renders the driven toggle, shows its hint, and lets an unlocked switch call back', () => {
    const onChange = vi.fn(() => true)
    useSketchUiStore.setState({
      pendingDialog: {
        position: [0, 0],
        label: 'dimension',
        defaultValue: '10',
        quantity: 'length',
        onConfirm: vi.fn(),
        toggle: {
          label: 'Driven', value: false, hint: 'Only measures; does not constrain.',
          onChange,
        },
      },
    })
    render(<ContextMenuDialog />)

    const toggle = screen.getByRole('checkbox', { name: 'Driven' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(toggle.closest('label')?.getAttribute('title')).toBe('Only measures; does not constrain.')
    expect(screen.getByText('Only measures; does not constrain.')).toBeInTheDocument()
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.readOnly).toBe(false)

    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
    expect((screen.getByRole('checkbox', { name: 'Driven' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('textbox') as HTMLInputElement).readOnly).toBe(true)
  })

  it('turning the toggle on restores the measured value after a typed edit', () => {
    const onConfirm = vi.fn()
    useSketchUiStore.setState({
      pendingDialog: {
        position: [0, 0],
        label: 'dimension',
        defaultValue: '10',
        quantity: 'length',
        onConfirm,
        toggle: { label: 'Driven', value: false, onChange: () => true },
      },
    })
    render(<ContextMenuDialog />)

    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Driven' }))

    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('10')
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onConfirm).toHaveBeenCalledWith('10')
  })

  it('a locked driven toggle cannot be changed and its value box is read-only', () => {
    const onChange = vi.fn()
    useSketchUiStore.setState({
      pendingDialog: {
        position: [0, 0],
        label: 'dimension',
        defaultValue: '73.74',
        quantity: 'angle',
        onConfirm: vi.fn(),
        toggle: {
          label: 'Driven', value: true, locked: true,
          hint: 'Already set by the existing constraints; this dimension can only measure.',
          onChange,
        },
      },
    })
    render(<ContextMenuDialog />)

    const toggle = screen.getByRole('checkbox', { name: 'Driven' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/this dimension can only measure/)).toBeInTheDocument()
    expect((screen.getByRole('textbox') as HTMLInputElement).readOnly).toBe(true)
    fireEvent.click(toggle)
    expect(onChange).not.toHaveBeenCalled()

    // A read-only measured box confirms without validation: a measured angle
    // of 0 is legal even though the driving value rule refuses it.
    const onConfirm = vi.fn()
    act(() => {
      useSketchUiStore.setState({ pendingDialog: { ...useSketchUiStore.getState().pendingDialog!, onConfirm, validate: () => 'never valid' } })
    })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onConfirm).toHaveBeenCalledWith('73.74')
  })

  it('shows the quantity unit inside the box and says it in the accessible name', () => {
    // The freshly placed dimension's prompt carries a quantity, so it reads like
    // the double-click editor: the unit sits in the box and the input's name
    // spells it out.
    useSketchUiStore.setState({
    pendingDialog: {
        position: [0, 0],
        label: 'Dimension value',
        defaultValue: '12.5',
        quantity: 'length',
        onConfirm: vi.fn(),
      },
  })
    const { unmount } = render(<ContextMenuDialog />)
    const lengthInput = screen.getByRole('textbox', { name: 'Dimension value, millimetres' })
    expect(lengthInput.closest('.field-unit-box')?.querySelector('.field-unit')?.textContent).toBe('mm')
    unmount()

    useSketchUiStore.setState({
    pendingDialog: {
        position: [0, 0],
        label: 'Dimension value',
        defaultValue: '45',
        quantity: 'angle',
        onConfirm: vi.fn(),
      },
  })
    render(<ContextMenuDialog />)
    const angleInput = screen.getByRole('textbox', { name: 'Dimension value, degrees' })
    expect(angleInput.closest('.field-unit-box')?.querySelector('.field-unit')?.textContent).toBe('deg')
  })
})

// The value dialog is not built on the Dialog shell, so it used to be the one
// surface that never claimed the modal stand-down. Its number input hides the
// hole (dispatchKey ignores editable targets), so the bug only surfaced once
// focus moved to a button: Ctrl+Z then ran the document undo, which committed
// the pending work, tore the editor state down and nulled pendingDialog, so the
// dialog vanished mid-gesture with onCancel never called and the typed value
// lost.
describe('ContextMenuDialog claims the modal stand-down', () => {  beforeEach(() => {
    clearAllHandlers()
    resetModalEscape()
    // A still-mounted dialog from the previous test subscribes to the store, so
    // the reset has to land inside act.
    act(() => { useSketchUiStore.setState({
    pendingDialog: null,
  }) })
  })

  afterEach(() => {
    clearAllHandlers()
    resetModalEscape()
    act(() => { useSketchUiStore.setState({
    pendingDialog: null,
  }) })
  })

  function openDialog(onConfirm: (v: string) => void = vi.fn(), onCancel: () => void = vi.fn()) {
    act(() => {
      useSketchUiStore.setState({
    pendingDialog: {
          position: [0, 0],
          label: 'Dimension value',
          defaultValue: '10',
          onConfirm,
          onCancel,
        },
  })
    })
  }

  // Same order as production: the global dispatcher is on window long before any
  // dialog mounts, so listener order alone can never protect the editor.
  function attachDispatch(): () => void {
    window.addEventListener('keydown', dispatchKey)
    return () => window.removeEventListener('keydown', dispatchKey)
  }

  it('holds the claim while it is open and drops it on unmount', () => {
    openDialog()
    const view = render(<ContextMenuDialog />)
    expect(modalOwnsEscape()).toBe(true)
    view.unmount()
    expect(modalOwnsEscape()).toBe(false)
  })

  it('a ctrl+z from a dialog button leaves the dialog and its value alone', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const undo = vi.fn()
    openDialog(onConfirm, onCancel)
    registerCommand('undo', undo)
    const detach = attachDispatch()

    render(<ContextMenuDialog />)
    // Focus on a button is where dispatchKey stops seeing an editable target.
    const ok = screen.getByRole('button', { name: 'OK' })
    ok.focus()
    fireEvent.keyDown(ok, { key: 'z', ctrlKey: true })
    detach()

    expect(undo).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(useSketchUiStore.getState().pendingDialog).not.toBeNull()
  })

  it('a Delete from a dialog button stands down as well', () => {
    const onCancel = vi.fn()
    const del = vi.fn()
    openDialog(vi.fn(), onCancel)
    registerCommand('delete_selected', del)
    const detach = attachDispatch()

    render(<ContextMenuDialog />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Delete' })
    detach()

    expect(del).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(useSketchUiStore.getState().pendingDialog).not.toBeNull()
  })

  it('Escape still cancels the dialog through its own listener, not the dispatcher', () => {
    const onCancel = vi.fn()
    openDialog(vi.fn(), onCancel)
    const detach = attachDispatch()

    render(<ContextMenuDialog />)
    fireEvent.keyDown(window, { key: 'Escape' })
    detach()

    expect(onCancel).toHaveBeenCalledOnce()
    expect(useSketchUiStore.getState().pendingDialog).toBeNull()
  })

  // The negative control: without the dialog on screen the very same keystroke
  // reaches the document, so the assertions above are not vacuous.
  it('once closed, the same ctrl+z from the body reaches the document undo', () => {
    const undo = vi.fn()
    openDialog()
    registerCommand('undo', undo)
    const view = render(<ContextMenuDialog />)
    view.unmount()
    const detach = attachDispatch()

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    detach()

    expect(undo).toHaveBeenCalledOnce()
  })
})

// The dialog takes the feature card's look: the same frost surface and verdict
// buttons, the card's field label, and a leading glyph the caller resolves.
// jsdom applies no stylesheet, so the sizing rules are read from the files.
describe('ContextMenuDialog looks like the sketch property card', () => {
  const css = (file: string) => readFileSync(join(__dirname, file), 'utf8')

  beforeEach(() => {
    act(() => { useSketchUiStore.setState({ pendingDialog: null }) })
  })

  function open(over: Record<string, unknown> = {}) {
    act(() => {
      useSketchUiStore.setState({
        pendingDialog: {
          position: [0, 0],
          label: 'dimension',
          defaultValue: '2.45969',
          quantity: 'length',
          onConfirm: vi.fn(),
          ...over,
        },
      })
    })
  }

  it('carries the shared frost surface and verdict buttons', () => {
    open()
    render(<ContextMenuDialog />)

    const root = document.querySelector('.context-menu-dialog')!
    expect(root).toHaveClass('glass-panel')
    expect(screen.getByRole('button', { name: 'OK' })).toHaveClass('feature-ok-btn')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('feature-cancel-btn')
  })

  it('renders the state icon as the leading glyph, and none when absent', () => {
    open({ icon: '/icons/dimension-angle.svg' })
    const withIcon = render(<ContextMenuDialog />)
    const img = document.querySelector('.context-menu-dialog img.feature-icon') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('/icons/dimension-angle.svg')
    withIcon.unmount()

    open()
    render(<ContextMenuDialog />)
    expect(document.querySelector('.context-menu-dialog img.feature-icon')).toBeNull()
  })

  it('accepts an expression: a text box, not a number spinner', () => {
    open()
    render(<ContextMenuDialog />)
    const input = screen.getByRole('textbox', { name: 'dimension, millimetres' }) as HTMLInputElement
    expect(input.getAttribute('inputmode')).toBe('decimal')
    fireEvent.change(input, { target: { value: '2*w' } })
    expect(input.value).toBe('2*w')
  })

  it('flips left at the right edge instead of pushing OK off screen', () => {
    act(() => {
      useSketchUiStore.setState({
        pendingDialog: {
          position: [980, 20],
          label: 'dimension',
          defaultValue: '10',
          quantity: 'length',
          onConfirm: vi.fn(),
        },
      })
    })
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 40, width: 300, height: 40,
      toJSON: () => ({}),
    } as DOMRect)
    try {
      render(<ContextMenuDialog />)
      const root = document.querySelector('.context-menu-dialog') as HTMLElement
      // The anchor is 980 + 12 = 992 and the measured row is 300 wide; the
      // window is 1024, so it flips to 992 - 300 = 692.
      expect(root.style.left).toBe('692px')
      expect(root.style.top).toBe('28px')
    } finally {
      rect.mockRestore()
    }
  })

  it('sizes the input for -12345.12345 with the unit suffix reserved', () => {
    // The widest formatted default is `-12345.12345`, twelve monospace chars;
    // 14ch holds it with two to spare, and the extra 34px is the input's left
    // padding plus the unit slot's right padding.
    const dialogCss = css('../ContextMenuDialog.css')
    const inputRule = /\.context-menu-dialog \.context-menu-input\s*\{([^}]*)\}/.exec(dialogCss)![1]
    expect(inputRule).toMatch(/min-width:\s*calc\(14ch \+ 34px\)/)
    expect(inputRule).toMatch(/width:\s*calc\(14ch \+ 34px\)/)
    expect(inputRule).toMatch(/ui-monospace/)
    expect(inputRule).toMatch(/background:\s*var\(--glass-field-bg\)/)

    // The suffix's own reservation is the shared UnitBox rule: a box with a
    // unit keeps a 26px right padding, so the digits never run under `mm`.
    const glassCss = css('../../layout/Glass.css')
    const unitRule = /\.field-unit-box--with-unit > input\s*\{([^}]*)\}/.exec(glassCss)![1]
    expect(unitRule).toMatch(/padding-right:\s*var\(--field-unit-slot\)/)
    expect(glassCss).toMatch(/--field-unit-slot:\s*26px/)

    open()
    render(<ContextMenuDialog />)
    const input = screen.getByRole('textbox', { name: 'dimension, millimetres' })
    expect(input).toHaveClass('feature-field-input')
    expect(input.closest('.field-unit-box')).toHaveClass('field-unit-box--with-unit')
  })
})
