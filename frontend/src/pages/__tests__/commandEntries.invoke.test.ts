import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { constraintCommandSpec, escapeStage, openOffsetDialog, PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { useSketchEditorStore, setSketchCallback, useSketchUiStore } from '@/stores/sketchEditorStore'
import type { DialogState } from '@/stores/sketchEditorStore'
import type { ConstraintDef } from '@/registry'
import { initializeTools } from '@/tools'
import { acquireModalEscape, modalOwnsEscape, resetModalEscape } from '@/utils/core/modalEscape'
import { useEditorState } from '@/hooks/useEditorState'
import { partContext, partRegistry } from './commandFixtures'

// The structural suites pin the spec table; this one drives the store-driven
// command bodies (cancel_draw / set_tool_mirror / apply_offset) against the
// real stores with the context callbacks spied, so a renamed store action or a
// dropped step in a multi-call body (e.g. cancel_draw forgetting to clear the
// pick field) fails.

const noop = () => {}

function execute(name: Parameters<ReturnType<typeof partRegistry>['execute']>[0], context = partContext(), params?: unknown) {
  return partRegistry(context).execute(name, params)
}

describe('command bodies that drive the sketch editor store', () => {
  // cancel_draw stands down under a dialog, so these only mean anything with no
  // dialog claiming Escape. Do not rely on another suite's teardown for that.
  beforeEach(() => {
    resetModalEscape()
    useSketchUiStore.setState({
    pendingDialog: null,
  })
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('cancel_pick is gone: Escape reaches the pick field through cancel_draw', () => {
    const names = PART_COMMAND_SPECS.map(s => s.id)
    expect(names).not.toContain('cancel_pick')
  })

  it('set_tool_mirror surfaces a not-implemented notice (showMessage) and does not switch tools', () => {
    const store = useSketchEditorStore.getState()
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)
    const showMessage = vi.fn()

    execute('set_tool_mirror', partContext({ showMessage }))

    expect(showMessage).toHaveBeenCalledOnce()
    expect(showMessage).toHaveBeenCalledWith({ title: 'Not Implemented', message: 'Mirror tool is not yet implemented.', variant: 'info' })
    expect(setActiveTool).not.toHaveBeenCalled()
  })

  it('set_tool_select / set_tool_drag forward the tool id', () => {
    const store = useSketchEditorStore.getState()
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    execute('set_tool_select')
    execute('set_tool_drag')

    expect(setActiveTool).toHaveBeenNthCalledWith(1, null)
    expect(setActiveTool).toHaveBeenNthCalledWith(2, 'drag')
  })

  // The compound tools (rect/center_rect/ngon) and dimension have no ENTITIES
  // entry, so their set_tool_* commands are hardcoded in the spec table.
  // The toolbar button dispatches set_tool_<tool>, so a dropped entry would
  // make the button silently inert: assert each spec exists AND forwards the
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

    execute(name as Parameters<typeof execute>[0])

    expect(setActiveTool).toHaveBeenCalledWith(id)
  })

  it('set_tool_project arms the pick tool when the selection has nothing to project', () => {
    // Empty selection alone forces the false path; the callback reset is
    // belt-and-suspenders in case a prior test left a mutation seam registered.
    useEditorState.setState({
    normalSelection: new Set(),
    activeFeatureId: null,
  })
    setSketchCallback('onMutationBatch', null)
    const store = useSketchEditorStore.getState()
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    execute('set_tool_project')

    expect(setActiveTool).toHaveBeenCalledWith('project')
  })

  it('toggle_construction forwards to the store', () => {
    const store = useSketchEditorStore.getState()
    const toggleConstruction = vi.spyOn(store, 'toggleConstruction').mockImplementation(noop)

    execute('toggle_construction')

    expect(toggleConstruction).toHaveBeenCalledOnce()
  })

  it('apply_concentric applies the constraint and never shows a toast', () => {
    const store = useSketchEditorStore.getState()
    const applyConstraint = vi.spyOn(store, 'applyConstraint').mockReturnValue(null)
    const showMessage = vi.fn()

    execute('apply_concentric', partContext({ showMessage }))

    expect(applyConstraint).toHaveBeenCalledWith('concentric')
    expect(showMessage).not.toHaveBeenCalled()
  })

  it('surfaces an operand-kind rejection from applyConstraint via showMessage', () => {
    const store = useSketchEditorStore.getState()
    vi.spyOn(store, 'applyConstraint').mockReturnValue('Parallel cannot be applied to those entity kinds (arc, arc).')
    const showMessage = vi.fn()

    execute('apply_parallel', partContext({ showMessage }))

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

    const spec = constraintCommandSpec(fake)
    const ctx = partContext({
      showMessage,
      state: () => ({ ...useSketchEditorStore.getState(), ...useSketchUiStore.getState(), applyConstraint }),
    })
    spec.run(ctx, null)

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
    useEditorState.setState({
    activePickField: null,
    modeStack: [],
  })
  useSketchUiStore.setState({
    pendingDialog: null,
  })
    useSketchEditorStore.getState().setActiveTool(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useSketchEditorStore.getState().setActiveTool(null)
    useEditorState.setState({
    dimensionPicks: [],
    drawPoints: [],
  })
  })

  it('with nothing in progress clears the draw, the pick field and disarms the tool', () => {
    const store = useSketchEditorStore.getState()
    const clearDraw = vi.spyOn(store, 'clearDraw').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)
    const setActivePickField = vi.spyOn(store, 'setActivePickField').mockImplementation(noop)

    execute('cancel_draw')

    expect(clearDraw).toHaveBeenCalledOnce()
    expect(setActiveTool).toHaveBeenCalledWith(null)
    expect(setActivePickField).toHaveBeenCalledWith(null)
    // Pick before tool: on a desynced stack with 'pick' on top, the tool's
    // deactivate hook would otherwise pop the pick's mode entry (the production
    // comment on the disarm branch names this order as load-bearing).
    expect(setActivePickField.mock.invocationCallOrder[0])
      .toBeLessThan(setActiveTool.mock.invocationCallOrder[0])
  })

  it('with draw points in progress clears the draw and keeps the tool', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useEditorState.setState({
    drawPoints: [[0, 0], [10, 0]],
  })

    const store = useSketchEditorStore.getState()
    const clearDraw = vi.spyOn(store, 'clearDraw').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    execute('cancel_draw')

    expect(clearDraw).toHaveBeenCalledOnce()
    expect(setActiveTool).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().activeTool).toBe('line')
  })

  it('a second cancel_draw with nothing in progress then disarms the tool', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useEditorState.setState({
    drawPoints: [[0, 0], [10, 0]],
  })

    // First press cancels the in-progress entity but keeps the tool armed.
    execute('cancel_draw')
    expect(useSketchEditorStore.getState().activeTool).toBe('line')
    // The real clearDraw wiped the buffer, so the second press has nothing in progress.
    expect(useSketchEditorStore.getState().drawPoints).toEqual([])

    // Second press: nothing in progress, so it disarms the tool.
    execute('cancel_draw')
    expect(useSketchEditorStore.getState().activeTool).toBeNull()
    expect(useSketchEditorStore.getState().modeStack).toEqual([])
  })

  it('with dimension picks clears the picks and keeps the dimension tool', () => {
    useSketchEditorStore.getState().setActiveTool('dimension')
    useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
  })

    const store = useSketchEditorStore.getState()
    const cancelBrep = vi.spyOn(store, 'cancelBrepProjectionGesture').mockImplementation(noop)
    const clearDimensionPicks = vi.spyOn(store, 'clearDimensionPicks').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    execute('cancel_draw')

    expect(cancelBrep).toHaveBeenCalledOnce()
    expect(clearDimensionPicks).toHaveBeenCalledOnce()
    expect(setActiveTool).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().activeTool).toBe('dimension')
  })

  it('with an open pick field clears the field and disarms the tool', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'sketch1', field: 'plane' })

    const store = useSketchEditorStore.getState()
    const setActivePickField = vi.spyOn(store, 'setActivePickField').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    execute('cancel_draw')

    // Pick before tool, so clearing the field never eats the pick's mode entry:
    // the production comment on the pick branch makes this order the contract.
    expect(setActivePickField).toHaveBeenCalledWith(null)
    expect(setActiveTool).toHaveBeenCalledWith(null)
    expect(setActivePickField.mock.invocationCallOrder[0])
      .toBeLessThan(setActiveTool.mock.invocationCallOrder[0])
  })
})

// Undo must not destroy an in-progress draw AND pop a real history entry from
// one keystroke. Its first stage mirrors Escape's cancel_gesture arm: with a
// half-placed entity (draw points) or a half-built dimension in the store it
// cancels just that and never reaches the undo port; with nothing in progress
// it falls through to the real undo. Driven against the real store so the
// shared cancelInProgressGesture helper keeps the mode-stack invariants intact.
describe('undo cancels an in-progress gesture before touching history', () => {
  beforeAll(() => { initializeTools() })

  beforeEach(() => {
    resetModalEscape()
    useEditorState.setState({
    activePickField: null,
    modeStack: [],
  })
  useSketchUiStore.setState({
    pendingDialog: null,
  })
    useSketchEditorStore.getState().setActiveTool(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useSketchEditorStore.getState().setActiveTool(null)
    useEditorState.setState({
    dimensionPicks: [],
    drawPoints: [],
  })
  })

  it('with draw points in progress cancels the gesture and never calls undo', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useEditorState.setState({
    drawPoints: [[0, 0]],
  })
    const undo = vi.fn()

    execute('undo', partContext({ undo }))

    expect(undo).not.toHaveBeenCalled()
    // The real clearDraw wiped the buffer, so a second press has nothing in progress.
    expect(useSketchEditorStore.getState().drawPoints).toEqual([])
    // The tool stays armed, exactly as the Escape cancel_gesture arm keeps it.
    expect(useSketchEditorStore.getState().activeTool).toBe('line')
  })

  it('a second undo with an empty gesture calls undo exactly once', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useEditorState.setState({
    drawPoints: [[0, 0]],
  })
    const undo = vi.fn()

    // First press discards the half-placed point without popping history.
    execute('undo', partContext({ undo }))
    expect(undo).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().drawPoints).toEqual([])

    // Second press: nothing in progress, so it reaches the real undo.
    execute('undo', partContext({ undo }))
    expect(undo).toHaveBeenCalledOnce()
  })

  it('with dimension picks in progress cancels the gesture and never calls undo', () => {
    useSketchEditorStore.getState().setActiveTool('dimension')
    useEditorState.setState({
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
  })
    const cancelBrep = vi.spyOn(useSketchEditorStore.getState(), 'cancelBrepProjectionGesture').mockImplementation(noop)
    const undo = vi.fn()

    execute('undo', partContext({ undo }))

    expect(undo).not.toHaveBeenCalled()
    expect(cancelBrep).toHaveBeenCalledOnce()
    expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])
    expect(useSketchEditorStore.getState().activeTool).toBe('dimension')
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
    useSketchUiStore.setState({
    pendingDialog: null,
  })
    useSketchEditorStore.getState().setActiveTool(null)
    vi.restoreAllMocks()
  })

  it('leaves the store untouched when pendingDialog is set', () => {
    useSketchUiStore.setState({
    pendingDialog: openDialog,
  })
    const store = useSketchEditorStore.getState()
    const clearDraw = vi.spyOn(store, 'clearDraw').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)
    const setActivePickField = vi.spyOn(store, 'setActivePickField').mockImplementation(noop)

    execute('cancel_draw')

    expect(clearDraw).not.toHaveBeenCalled()
    expect(setActiveTool).not.toHaveBeenCalled()
    expect(setActivePickField).not.toHaveBeenCalled()
  })

  it('does not clear an in-progress draw while a dialog owns Escape', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useEditorState.setState({
    drawPoints: [[0, 0], [10, 0]],
  })
  useSketchUiStore.setState({
    pendingDialog: openDialog,
  })
    const store = useSketchEditorStore.getState()
    const clearDraw = vi.spyOn(store, 'clearDraw').mockImplementation(noop)
    const setActiveTool = vi.spyOn(store, 'setActiveTool').mockImplementation(noop)

    execute('cancel_draw')

    expect(clearDraw).not.toHaveBeenCalled()
    expect(setActiveTool).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().drawPoints).toEqual([[0, 0], [10, 0]])
  })

  it('keeps the armed tool armed with a dialog open, and disarms it once closed', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    useSketchUiStore.setState({
    pendingDialog: openDialog,
  })

    execute('cancel_draw')
    expect(useSketchEditorStore.getState().activeTool).toBe('line')

    useSketchUiStore.setState({
    pendingDialog: null,
  })
    execute('cancel_draw')
    expect(useSketchEditorStore.getState().activeTool).toBeNull()
    expect(useSketchEditorStore.getState().modeStack).toEqual([])
  })

  it('still clears an armed pick field once the dialog is closed', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'sketch1', field: 'plane' })
    useSketchUiStore.setState({
    pendingDialog: openDialog,
  })

    execute('cancel_draw')
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()

    useSketchUiStore.setState({
    pendingDialog: null,
  })
    execute('cancel_draw')
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
    expect(useSketchEditorStore.getState().modeStack).toEqual([])
  })

  it('a modal claim alone stands cancel_draw down, with pendingDialog null', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    const release = acquireModalEscape()

    execute('cancel_draw')
    expect(useSketchEditorStore.getState().activeTool).toBe('line')

    release()
    execute('cancel_draw')
    expect(useSketchEditorStore.getState().activeTool).toBeNull()
  })

  it('an outer modal keeps the claim when an inner one closes', () => {
    useSketchEditorStore.getState().setActiveTool('line')
    const releaseOuter = acquireModalEscape()
    const releaseInner = acquireModalEscape()

    releaseInner()
    execute('cancel_draw')
    expect(useSketchEditorStore.getState().activeTool).toBe('line')

    releaseOuter()
    execute('cancel_draw')
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

// apply_offset takes its distance as data; the dialog is only the user-facing
// front end. The programmatic path must never open a dialog.
describe('apply_offset data command and its dialog front end', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('programmatic execution applies the parsed distance and opens no dialog', () => {
    const store = useSketchEditorStore.getState()
    const applyOffset = vi.spyOn(store, 'applyOffset').mockImplementation(noop)
    const openDialog = vi.spyOn(useSketchUiStore.getState(), 'openDialog').mockImplementation(noop)

    const result = execute('apply_offset', partContext(), { distance: 3.5 })

    expect(result).toEqual({ ok: true, createdIds: [] })
    expect(applyOffset).toHaveBeenCalledWith(3.5)
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('rejects a payload that is not a numeric distance', () => {
    const registry = partRegistry()
    const result = registry.execute('apply_offset', { distance: 'five' })
    expect(result.ok).toBe(false)
  })

  it('the dialog front end collects the distance and hands it to execute', () => {
    let captured: DialogState | undefined
    vi.spyOn(useSketchUiStore.getState(), 'openDialog').mockImplementation((opts) => { captured = opts })
    const closeDialog = vi.spyOn(useSketchUiStore.getState(), 'closeDialog').mockImplementation(noop)
    const onDistance = vi.fn()

    openOffsetDialog(onDistance)

    expect(captured).toBeDefined()
    expect(captured!.label).toMatch(/offset/i)
    expect(captured!.defaultValue).toBe('5')
    // validator rejects non-numbers, accepts numbers
    expect(captured!.validate!('not a number')).toBeTruthy()
    expect(captured!.validate!('2.5')).toBeNull()

    captured!.onConfirm('3.5')
    expect(onDistance).toHaveBeenCalledWith(3.5)
    expect(closeDialog).toHaveBeenCalledOnce()
  })

  it('the dialog front end closes without calling back on cancel', () => {
    let captured: DialogState | undefined
    vi.spyOn(useSketchUiStore.getState(), 'openDialog').mockImplementation((opts) => { captured = opts })
    const closeDialog = vi.spyOn(useSketchUiStore.getState(), 'closeDialog').mockImplementation(noop)
    const onDistance = vi.fn()

    openOffsetDialog(onDistance)
    captured!.onCancel!()

    expect(onDistance).not.toHaveBeenCalled()
    expect(closeDialog).toHaveBeenCalledOnce()
  })
})
