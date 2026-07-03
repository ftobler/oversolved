import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildCommandEntries } from '@/pages/commandEntries'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { DialogState } from '@/stores/sketchEditorStore'

// The structural suites build the entry list but never invoke the store-driven
// command bodies (cancel_draw / cancel_pick / set_tool_mirror / apply_offset).
// Those `fn` closures were uncovered. This drives each one against the real
// store with the actions spied, so a renamed store action or a dropped step in
// a multi-call body (e.g. cancel_draw forgetting to clear the pick field) fails.

const noop = () => {}

function entry(name: string) {
  const entries = buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, noop)
  const e = entries.find(x => x.name === name)
  if (!e) throw new Error(`no command entry ${name}`)
  return e
}

describe('command callbacks that drive the sketch editor store', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('cancel_draw clears the draw, the active tool, and the pick field', () => {
    const store = useSketchEditorStore.getState()
    const clearDraw = vi.spyOn(store, 'clearDraw').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)
    const setActivePickField = vi.spyOn(store, 'setActivePickField').mockImplementation(noop)

    entry('cancel_draw').fn()

    expect(clearDraw).toHaveBeenCalledOnce()
    expect(setActiveTool).toHaveBeenCalledWith(null)
    expect(setActivePickField).toHaveBeenCalledWith(null)
  })

  it('cancel_pick clears only the pick field', () => {
    const store = useSketchEditorStore.getState()
    const setActivePickField = vi.spyOn(store, 'setActivePickField').mockImplementation(noop)

    entry('cancel_pick').fn()

    expect(setActivePickField).toHaveBeenCalledWith(null)
  })

  it('set_tool_mirror surfaces a not-implemented notice (showMessage) and does not switch tools', () => {
    const store = useSketchEditorStore.getState()
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)
    const showMessage = vi.fn()

    const entries = buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, showMessage)
    const e = entries.find(x => x.name === 'set_tool_mirror')!
    e.fn()

    expect(showMessage).toHaveBeenCalledOnce()
    expect(showMessage).toHaveBeenCalledWith({ title: 'Not Implemented', message: 'Mirror tool is not yet implemented.', variant: 'info' })
    expect(setActiveTool).not.toHaveBeenCalled()
  })

  it('set_tool_select / set_tool_drag forward the tool id', () => {
    const store = useSketchEditorStore.getState()
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    entry('set_tool_select').fn()
    entry('set_tool_drag').fn()

    expect(setActiveTool).toHaveBeenNthCalledWith(1, null)
    expect(setActiveTool).toHaveBeenNthCalledWith(2, 'drag')
  })

  it('toggle_construction forwards to the store', () => {
    const store = useSketchEditorStore.getState()
    const toggleConstruction = vi.spyOn(store, 'toggleConstruction').mockImplementation(noop)

    entry('toggle_construction').fn()

    expect(toggleConstruction).toHaveBeenCalledOnce()
  })
})

describe('apply_offset command opens a distance dialog', () => {
  let captured: DialogState | undefined

  beforeEach(() => {
    captured = undefined
    const store = useSketchEditorStore.getState()
    vi.spyOn(store, 'openDialog').mockImplementation((opts) => { captured = opts })
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('opens a dialog with a numeric default and a validator', () => {
    entry('apply_offset').fn()
    expect(captured).toBeDefined()
    expect(captured!.label).toMatch(/offset/i)
    expect(captured!.defaultValue).toBe('5')
    // validator rejects non-numbers, accepts numbers
    expect(captured!.validate!('not a number')).toBeTruthy()
    expect(captured!.validate!('2.5')).toBeNull()
  })

  it('confirm applies the parsed offset and closes the dialog', () => {
    const store = useSketchEditorStore.getState()
    const applyOffset = vi.spyOn(store, 'applyOffset').mockImplementation(noop)
    const closeDialog = vi.spyOn(store, 'closeDialog').mockImplementation(noop)

    entry('apply_offset').fn()
    captured!.onConfirm('3.5')

    expect(applyOffset).toHaveBeenCalledWith(3.5)
    expect(closeDialog).toHaveBeenCalledOnce()
  })

  it('cancel closes the dialog without applying', () => {
    const store = useSketchEditorStore.getState()
    const applyOffset = vi.spyOn(store, 'applyOffset').mockImplementation(noop)
    const closeDialog = vi.spyOn(store, 'closeDialog').mockImplementation(noop)

    entry('apply_offset').fn()
    captured!.onCancel!()

    expect(applyOffset).not.toHaveBeenCalled()
    expect(closeDialog).toHaveBeenCalledOnce()
  })
})
