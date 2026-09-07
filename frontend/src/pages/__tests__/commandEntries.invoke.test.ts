import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { buildCommandEntries, constraintCommandFn, escapeStage } from '@/pages/commandEntries'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import type { DialogState } from '@/stores/sketchEditorStore'
import type { ConstraintDef } from '@/registry'
import { initializeTools } from '@/tools'
import { acquireModalEscape, modalOwnsEscape, resetModalEscape } from '@/utils/core/modalEscape'

// The structural suites build the entry list but never invoke the store-driven
// command bodies (cancel_draw / set_tool_mirror / apply_offset). Those `fn`
// closures were uncovered. This drives each one against the real store with the
// actions spied, so a renamed store action or a dropped step in a multi-call
// body (e.g. cancel_draw forgetting to clear the pick field) fails.

const noop = () => {}

function entry(name: string) {
  const entries = buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, noop)
  const e = entries.find(x => x.name === name)
  if (!e) throw new Error(`no command entry ${name}`)
  return e
}

describe('command callbacks that drive the sketch editor store', () => {
  // cancel_draw stands down under a dialog, so these only mean anything with no
  // dialog claiming Escape. Do not rely on another suite's teardown for that.
  beforeEach(() => {
    resetModalEscape()
    useSketchEditorStore.setState({ pendingDialog: null })
  })

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
    // Order is load-bearing: the tool's deactivate hook pops the mode stack, so
    // on a desynced stack with 'pick' on top it would eat the pick's entry.
    expect(setActivePickField.mock.invocationCallOrder[0])
      .toBeLessThan(setActiveTool.mock.invocationCallOrder[0])
  })

  it('cancel_pick is gone: Escape reaches the pick field through cancel_draw', () => {
    const entries = buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, noop)
    expect(entries.find(e => e.name === 'cancel_pick')).toBeUndefined()
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

  // The compound tools (rect/center_rect/ngon) and dimension have no ENTITIES
  // entry, so their set_tool_* commands are hardcoded in buildCommandEntries.
  // The toolbar button dispatches set_tool_<tool>, so a dropped entry would
  // make the button silently inert: assert each entry exists AND forwards the
  // right id. set_tool_project is separate: it only arms the pick tool when the
  // selection-action half (projectSelection) has nothing to do.
  const COMPOUND_TOOL_COMMANDS: [string, string][] = [
    ['set_tool_rect', 'rect'],
    ['set_tool_center_rect', 'center_rect'],
    ['set_tool_ngon', 'ngon'],
    ['set_tool_dimension', 'dimension'],
  ]
  it.each(COMPOUND_TOOL_COMMANDS)('%s exists and invokes setActiveTool(%s)', (name, id) => {
    const store = useSketchEditorStore.getState()
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    entry(name).fn()

    expect(setActiveTool).toHaveBeenCalledWith(id)
  })

  it('set_tool_project arms the pick tool when the selection has nothing to project', () => {
    // Empty selection alone forces the false path; the callback reset is
    // belt-and-suspenders in case a prior test left a mutation seam registered.
    useSketchEditorStore.setState({ normalSelection: new Set(), activeFeatureId: null })
    setSketchCallback('onMutationBatch', null)
    const store = useSketchEditorStore.getState()
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    entry('set_tool_project').fn()

    expect(setActiveTool).toHaveBeenCalledWith('project')
  })

  it('toggle_construction forwards to the store', () => {
    const store = useSketchEditorStore.getState()
    const toggleConstruction = vi.spyOn(store, 'toggleConstruction').mockImplementation(noop)

    entry('toggle_construction').fn()

    expect(toggleConstruction).toHaveBeenCalledOnce()
  })

  it('apply_concentric applies the constraint and never shows a toast', () => {
    const store = useSketchEditorStore.getState()
    const applyConstraint = vi.spyOn(store, 'applyConstraint').mockReturnValue(null)
    const showMessage = vi.fn()

    const entries = buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, showMessage)
    const e = entries.find(x => x.name === 'apply_concentric')!
    e.fn()

    expect(applyConstraint).toHaveBeenCalledWith('concentric')
    expect(showMessage).not.toHaveBeenCalled()
  })

  it('surfaces an operand-kind rejection from applyConstraint via showMessage', () => {
    const store = useSketchEditorStore.getState()
    vi.spyOn(store, 'applyConstraint').mockReturnValue('Parallel cannot be applied to those entity kinds (arc, arc).')
    const showMessage = vi.fn()

    const entries = buildCommandEntries(noop, noop, noop, noop, noop, noop, noop, noop, showMessage)
    entries.find(x => x.name === 'apply_parallel')!.fn()

    expect(showMessage).toHaveBeenCalledOnce()
    expect(showMessage).toHaveBeenCalledWith({
      title: 'Cannot apply constraint',
      message: 'Parallel cannot be applied to those entity kinds (arc, arc).',
      variant: 'error',
    })
  })

  it('a synthetic implemented:false constraint still surfaces the toast', () => {
    const showMessage = vi.fn()
    const applyConstraint = vi.fn()
    const fake: ConstraintDef = {
      kind: 'fake_thing',
      label: 'Fake Thing',
      description: 'synthetic unimplemented constraint',
      category: 'geometric',
      hasValue: false,
      refPattern: 'target',
      renderKind: 'symbol_unknown',
      showInToolbar: true,
      implemented: false,
    }

    constraintCommandFn(fake, () => ({ applyConstraint }), showMessage)()

    expect(showMessage).toHaveBeenCalledOnce()
    expect(showMessage).toHaveBeenCalledWith({ title: 'Not Implemented', message: 'Constraint "Fake Thing" is not yet implemented.', variant: 'info' })
    expect(applyConstraint).not.toHaveBeenCalled()
  })
})

// The staged Escape handler: cancel_mid-gesture keeps the tool armed, a second
// press (nothing in progress) disarms. Driven against the real store so the
// mode-stack invariants hold.
describe('cancel_draw staged disarm', () => {
  beforeAll(() => { initializeTools() })

  beforeEach(() => {
    resetModalEscape()
    useSketchEditorStore.setState({ pendingDialog: null, activePickField: null, modeStack: [] })
    useSketchEditorStore.getState().setActiveTool(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useSketchEditorStore.getState().setActiveTool(null)
    useSketchEditorStore.setState({ dimensionPicks: [], drawPoints: [] })
  })

  it('with nothing in progress clears the draw, the pick field and disarms the tool', () => {
    const store = useSketchEditorStore.getState()
    const clearDraw = vi.spyOn(store, 'clearDraw').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)
    const setActivePickField = vi.spyOn(store, 'setActivePickField').mockImplementation(noop)

    entry('cancel_draw').fn()

    expect(clearDraw).toHaveBeenCalledOnce()
    expect(setActiveTool).toHaveBeenCalledWith(null)
    expect(setActivePickField).toHaveBeenCalledWith(null)
    // Order is load-bearing: the tool's deactivate hook pops the mode stack, so
    // on a desynced stack with 'pick' on top it would eat the pick's entry.
    expect(setActivePickField.mock.invocationCallOrder[0])
      .toBeLessThan(setActiveTool.mock.invocationCallOrder[0])
  })

  it('with draw points in progress clears the draw and keeps the tool', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useSketchEditorStore.setState({ drawPoints: [[0, 0], [10, 0]] })

    const store = useSketchEditorStore.getState()
    const clearDraw = vi.spyOn(store, 'clearDraw').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    entry('cancel_draw').fn()

    expect(clearDraw).toHaveBeenCalledOnce()
    expect(setActiveTool).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().activeTool).toBe('line')
  })

  it('a second cancel_draw with nothing in progress then disarms the tool', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useSketchEditorStore.setState({ drawPoints: [[0, 0], [10, 0]] })

    // First press cancels the in-progress entity but keeps the tool armed.
    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activeTool).toBe('line')
    // The real clearDraw wiped the buffer, so the second press has nothing in progress.
    expect(useSketchEditorStore.getState().drawPoints).toEqual([])

    // Second press: nothing in progress, so it disarms the tool.
    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activeTool).toBeNull()
    expect(useSketchEditorStore.getState().modeStack).toEqual([])
  })

  it('with dimension picks clears the picks and keeps the dimension tool', () => {
    useSketchEditorStore.getState().setActiveTool('dimension')
    useSketchEditorStore.setState({
      dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
    })

    const store = useSketchEditorStore.getState()
    const cancelBrep = vi.spyOn(store, 'cancelBrepProjectionGesture').mockImplementation(noop)
    const clearDimensionPicks = vi.spyOn(store, 'clearDimensionPicks').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    entry('cancel_draw').fn()

    expect(cancelBrep).toHaveBeenCalledOnce()
    expect(clearDimensionPicks).toHaveBeenCalledOnce()
    expect(setActiveTool).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().activeTool).toBe('dimension')
  })

  it('with an open pick field clears the field before the tool', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'sketch1', field: 'plane' })

    const store = useSketchEditorStore.getState()
    const setActivePickField = vi.spyOn(store, 'setActivePickField').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    entry('cancel_draw').fn()

    expect(setActivePickField).toHaveBeenCalledWith(null)
    expect(setActiveTool).toHaveBeenCalledWith(null)
    expect(setActivePickField.mock.invocationCallOrder[0])
      .toBeLessThan(setActiveTool.mock.invocationCallOrder[0])
  })
})

describe('escapeStage pure helper', () => {
  const base = {
    modalOwns: false,
    pendingDialog: null,
    activePickField: null,
    drawPoints: { length: 0 },
    dimensionPicks: { length: 0 },
  }
  it("returns 'modal' when a modal or pending dialog owns Escape", () => {
    expect(escapeStage({ ...base, modalOwns: true })).toBe('modal')
    expect(escapeStage({ ...base, pendingDialog: { label: 'x' } })).toBe('modal')
  })
  it("returns 'pick' when a pick field is open", () => {
    expect(escapeStage({ ...base, activePickField: { featureId: 's', field: 'p' } })).toBe('pick')
  })
  it("returns 'cancel_gesture' when draw points or dimension picks are in progress", () => {
    expect(escapeStage({ ...base, drawPoints: { length: 2 } })).toBe('cancel_gesture')
    expect(escapeStage({ ...base, dimensionPicks: { length: 1 } })).toBe('cancel_gesture')
  })
  it("returns 'disarm' when nothing is in progress", () => {
    expect(escapeStage(base)).toBe('disarm')
    expect(escapeStage({ ...base, drawPoints: { length: 0 }, dimensionPicks: { length: 0 }, activePickField: null })).toBe('disarm')
  })
})

// Escape has more than one owner: every modal on the Dialog shell binds its own
// window listener, the sketch value dialog binds one too, and the global
// dispatchKey listener routes the same keystroke to cancel_draw. Without a guard
// both fire and dismissing a dialog also throws away the armed tool behind it.
describe('cancel_draw stands down while a dialog is open', () => {
  // The tool lifecycle hooks maintain the mode stack, and the store validates
  // the stack against activeTool, so the registry has to be live here.
  beforeAll(() => { initializeTools() })

  const openDialog: DialogState = {
    position: [10, 20],
    label: 'Length',
    onConfirm: () => {},
  }

  beforeEach(() => { resetModalEscape() })

  afterEach(() => {
    resetModalEscape()
    useSketchEditorStore.setState({ pendingDialog: null })
    useSketchEditorStore.getState().setActiveTool(null)
    vi.restoreAllMocks()
  })

  it('leaves the store untouched when pendingDialog is set', () => {
    useSketchEditorStore.setState({ pendingDialog: openDialog })
    const store = useSketchEditorStore.getState()
    const clearDraw = vi.spyOn(store, 'clearDraw').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)
    const setActivePickField = vi.spyOn(store, 'setActivePickField').mockImplementation(noop)

    entry('cancel_draw').fn()

    expect(clearDraw).not.toHaveBeenCalled()
    expect(setActiveTool).not.toHaveBeenCalled()
    expect(setActivePickField).not.toHaveBeenCalled()
  })

  it('does not clear an in-progress draw while a dialog owns Escape', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useSketchEditorStore.setState({ pendingDialog: openDialog, drawPoints: [[0, 0], [10, 0]] })
    const store = useSketchEditorStore.getState()
    const clearDraw = vi.spyOn(store, 'clearDraw').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    entry('cancel_draw').fn()

    expect(clearDraw).not.toHaveBeenCalled()
    expect(setActiveTool).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().drawPoints).toEqual([[0, 0], [10, 0]])
  })

  it('keeps the armed tool armed with a dialog open, and disarms it once closed', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useSketchEditorStore.setState({ pendingDialog: openDialog })

    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activeTool).toBe('line')

    useSketchEditorStore.setState({ pendingDialog: null })
    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activeTool).toBeNull()
    expect(useSketchEditorStore.getState().modeStack).toEqual([])
  })

  it('still clears an armed pick field once the dialog is closed', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'sketch1', field: 'plane' })
    useSketchEditorStore.setState({ pendingDialog: openDialog })

    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()

    useSketchEditorStore.setState({ pendingDialog: null })
    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
    expect(useSketchEditorStore.getState().modeStack).toEqual([])
  })

  it('a modal claim alone stands cancel_draw down, with pendingDialog null', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    const release = acquireModalEscape()

    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activeTool).toBe('line')

    release()
    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activeTool).toBeNull()
  })

  it('an outer modal keeps the claim when an inner one closes', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    const releaseOuter = acquireModalEscape()
    const releaseInner = acquireModalEscape()

    releaseInner()
    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activeTool).toBe('line')

    releaseOuter()
    entry('cancel_draw').fn()
    expect(useSketchEditorStore.getState().activeTool).toBeNull()
  })

  it('a double release cannot hand Escape back early', () => {
    const releaseA = acquireModalEscape()
    const releaseB = acquireModalEscape()
    releaseA()
    releaseA()
    expect(modalOwnsEscape()).toBe(true)
    releaseB()
    expect(modalOwnsEscape()).toBe(false)
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
