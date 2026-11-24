import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, act } from '@testing-library/react'
import {
  makeCallbacks, renderSidebar, resetStores, setupRollbackStore as setupStore,
  layoutFeatureRows, pressRow, movePointer, releasePointer, losePointerCapture,
  builtInFeatures, featureRow,
} from './sidebarTestHarness'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { applyReorderFeatures } from '@/utils/yamlMutations/featureAdmin'
import { featureDisplayName } from '@/utils/core/displayNames'
import type { PartDoc, PartFeature } from '@/types/cad'

// Four built-in rows followed by user rows, laid out 40px apart from y = 0 by
// layoutFeatureRows. The rollback bar is a separate li in the flow, so the row
// indices and the slot indices line up.
const sk1: PartFeature = { id: 'sk1', kind: 'sketch' }
function ex(id: string): PartFeature {
  return { id, kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } }
}
const features = [...builtInFeatures, sk1, ex('ex1'), ex('ex2')]

function row(id: string): HTMLElement {
  return featureRow(id)
}

function makeDoc(featureList: PartFeature[], rollback?: number): PartDoc {
  const doc: PartDoc = { version: 1, kind: 'part', features: featureList.map(f => ({ ...f })) }
  if (rollback !== undefined) doc.rollback = rollback
  return doc
}

beforeEach(() => {
  resetStores()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('row names match the warning vocabulary', () => {
  it('renders the label-or-ordinal name for authored rows', () => {
    // A default plane label and two unlabelled extrudes: the row text must be
    // the same name a warning uses, from the one shared helper.
    const authored: PartFeature[] = [
      { id: 'pl1', kind: 'plane', label: 'Plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 5 } } as PartFeature,
      sk1,
      ex('ex1'),
      ex('ex2'),
    ]
    const rows = [...builtInFeatures, ...authored]
    setupStore(rows, rows.length)
    renderSidebar()
    const nameOf = (id: string) =>
      document.querySelector(`[data-oversolved-handle="tree:feature:${id}"] .feature-name`)?.textContent
    expect(nameOf('pl1')).toBe('plane 4')
    expect(nameOf('sk1')).toBe('sketch 1')
    expect(nameOf('ex1')).toBe('extrude 1')
    expect(nameOf('ex2')).toBe('extrude 2')
    for (const feature of authored) {
      expect(nameOf(feature.id)).toBe(featureDisplayName(feature, rows))
    }
    // The builtins keep their names: they never appear in a warning.
    expect(nameOf('Top')).toBe('Top')
  })
})

describe('feature drag on pointer events', () => {  it('reorders when the pointer is released over the rollback bar', () => {
    // The reported bug: the bar's band accepted no native drop.
    const onMutation = vi.fn()
    setupStore(features, 5)  // bar between sk1 (4) and ex1 (5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('ex2'), { clientY: 260 })
    movePointer(200)  // the bar's band, between rows 4 and 5
    expect(row('ex1')).toHaveClass('drop-target-top')

    releasePointer(200)
    expect(onMutation).toHaveBeenCalledTimes(1)
    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'ex2', toIndex: 5 })
  })

  it('reorders when the pointer is released in the gap between two rows', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows({ gap: 4 })  // rows at 0, 44, 88, ... leaving a 4px gap each

    pressRow(row('ex2'), { clientY: 284 })
    movePointer(218)  // inside the gap between ex1 and ex2
    releasePointer(218)

    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'ex2', toIndex: 5 })
  })

  it('reorders to the end when the pointer is released below the last row', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(340)  // the empty tail below the last row
    expect(row('ex2')).toHaveClass('drop-target-bottom')
    releasePointer(340)

    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'sk1', toIndex: 7 })
  })

  it('reorders to the first user slot when the pointer is released over a built-in row', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('ex2'), { clientY: 260 })
    movePointer(10)  // over Origin
    expect(row('sk1')).toHaveClass('drop-target-top')
    expect(row('Origin')).not.toHaveClass('drop-target-top')
    releasePointer(10)

    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'ex2', toIndex: 4 })
  })

  it('drops a stale cue when the pointer leaves the list and releases nothing there', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('ex2'), { clientY: 260 })
    movePointer(200)
    expect(row('ex1')).toHaveClass('drop-target-top')

    movePointer(200, 500)  // horizontally outside the list
    expect(row('ex1')).not.toHaveClass('drop-target-top')
    expect(row('ex1')).not.toHaveClass('drop-target-bottom')

    releasePointer(200, 500)
    expect(onMutation).not.toHaveBeenCalled()
    expect(row('ex2')).not.toHaveClass('dragging')
  })

  it('abandons the drag on Escape without dispatching', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('ex2'), { clientY: 260 })
    movePointer(200)
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(row('ex1')).not.toHaveClass('drop-target-top')
    releasePointer(200)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('dispatches nothing for a release in its own slot or the slot right after it', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(170)  // sk1's own slot (4)
    releasePointer(170)

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(190)  // the slot just below sk1 (5)
    releasePointer(190)

    expect(onMutation).not.toHaveBeenCalled()
  })

  it('commits the release while a rebuild is running', () => {
    // The native drag lost its release when applying a rebuild stalled the main
    // thread; the pointer stream queues instead of dropping it.
    const onMutation = vi.fn()
    setupStore(features, 5)
    usePartEditorStore.setState({ isRebuilding: true })
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('ex2'), { clientY: 260 })
    movePointer(200)
    releasePointer(200)

    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'ex2', toIndex: 5 })
  })
})

describe('feature drag click safety', () => {
  it('a press and release under the drag threshold still selects the row', () => {
    const callbacks = makeCallbacks()
    setupStore(features, 5)
    renderSidebar(callbacks)
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    releasePointer(180)
    fireEvent.click(row('sk1'))

    expect(callbacks.onToggleSelect).toHaveBeenCalledWith('@sk1')
    expect(callbacks.onMutation).not.toHaveBeenCalled()
  })

  it('a press on a row action button never starts a drag', () => {
    const callbacks = makeCallbacks()
    setupStore(features, 5)
    renderSidebar(callbacks)
    layoutFeatureRows()

    const action = document.querySelector('.feature-context-btn') as HTMLElement
    pressRow(action, { clientY: 180 })
    movePointer(230)
    releasePointer(230)

    expect(callbacks.onMutation).not.toHaveBeenCalled()
    expect(row('sk1')).not.toHaveClass('dragging')
  })

  it('does not also toggle selection on the release that ends a drag', () => {
    const callbacks = makeCallbacks()
    setupStore(features, 5)
    renderSidebar(callbacks)
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(230)
    releasePointer(230)
    fireEvent.click(row('sk1'))

    expect(callbacks.onMutation).toHaveBeenCalledTimes(1)
    expect(callbacks.onToggleSelect).not.toHaveBeenCalled()
  })

  it('a small shaky move is still a click, not a drag', () => {
    // The shared drag threshold is 4px. A shaky click must keep selecting
    // instead of turning the row into a drag and losing the selection.
    const callbacks = makeCallbacks()
    setupStore(features, 5)
    renderSidebar(callbacks)
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(183)  // 3px
    releasePointer(183)
    fireEvent.click(row('sk1'))

    expect(row('sk1')).not.toHaveClass('dragging')
    expect(callbacks.onToggleSelect).toHaveBeenCalledWith('@sk1')
    expect(callbacks.onMutation).not.toHaveBeenCalled()
  })

  it('a later click on a built-in row is not eaten by the previous drag', async () => {
    // The drag's own click lands on the list, not a row, so no row click
    // consumes the suppression flag. It must expire on its own or the next
    // click delivered somewhere else is silently lost.
    const callbacks = makeCallbacks()
    setupStore(features, 5)
    renderSidebar(callbacks)
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(230)
    releasePointer(230)
    await new Promise(resolve => setTimeout(resolve, 0))
    fireEvent.click(row('Origin'))

    expect(callbacks.onToggleSelect).toHaveBeenCalledWith('@builtin_origin')
  })
})

describe('feature drag cancellation', () => {
  it('cancels on pointercancel without dispatching', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(230)
    expect(row('ex2')).toHaveClass('drop-target-top')

    fireEvent.pointerCancel(window, { pointerId: 0 })

    expect(row('ex2')).not.toHaveClass('drop-target-top')
    expect(row('sk1')).not.toHaveClass('dragging')
    releasePointer(230)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('cancels when the pointer capture is lost before the release', () => {
    // A release outside the browser window never reaches the page. The browser
    // drops the capture instead, which must cancel, never commit on a later
    // click.
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(230)
    expect(row('sk1')).toHaveClass('dragging')

    losePointerCapture(row('sk1'))
    expect(row('sk1')).not.toHaveClass('dragging')
    expect(row('ex2')).not.toHaveClass('drop-target-top')

    releasePointer(230)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('drops the gesture when the tree unmounts mid-drag', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    const view = renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(230)
    expect(row('sk1')).toHaveClass('dragging')

    view.unmount()
    movePointer(230)
    releasePointer(230)

    expect(onMutation).not.toHaveBeenCalled()
  })

  it('ignores a second pointer so it cannot steer or commit the drag', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180, pointerId: 1 })
    movePointer(230, 0, 1)
    expect(row('ex2')).toHaveClass('drop-target-top')

    // A second finger over Origin must not move the cue.
    movePointer(10, 0, 2)
    expect(row('ex2')).toHaveClass('drop-target-top')
    expect(row('Origin')).not.toHaveClass('drop-target-top')

    // Nor may its release commit the first pointer's gesture.
    releasePointer(10, 0, 2)
    expect(onMutation).not.toHaveBeenCalled()
    expect(row('sk1')).toHaveClass('dragging')

    releasePointer(230, 0, 1)
    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'sk1', toIndex: 6 })
  })

  it('cancels a release above the list and one below it on the Parts card', () => {
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('ex2'), { clientY: 260 })
    movePointer(200)
    expect(row('ex1')).toHaveClass('drop-target-top')

    movePointer(-20)  // the Features header, above the list
    expect(row('ex1')).not.toHaveClass('drop-target-top')

    movePointer(460)  // the Parts card, below the list
    expect(row('ex1')).not.toHaveClass('drop-target-top')
    releasePointer(460)

    expect(onMutation).not.toHaveBeenCalled()
  })
})

describe('feature drag across the rollback bar', () => {
  it('lands above the bar when dragged down into the bar slot', () => {
    const onMutation = vi.fn()
    setupStore(features, 6)  // bar between ex1 (5) and ex2 (6)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(220)  // bar slot 6
    expect(row('ex1')).toHaveClass('drop-target-bottom')
    expect(row('ex2')).not.toHaveClass('drop-target-top')

    releasePointer(220)
    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'sk1', toIndex: 6 })

    // Pin what the applier plus the rollback mirror do: the index stays parked,
    // so sk1 (now at 5) sits above the bar.
    const doc = makeDoc(features, 6)
    applyReorderFeatures(doc, 'sk1', 6)
    expect(doc.features!.map(f => f.id)).toEqual(['Origin', 'Top', 'Front', 'Right', 'ex1', 'sk1', 'ex2'])
    expect(doc.rollback).toBe(6)
  })

  it('lands below the bar when dragged up into the bar slot', () => {
    const onMutation = vi.fn()
    const wider = [...features, ex('ex3')]
    setupStore(wider, 6)  // bar between ex1 (5) and ex2 (6)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('ex3'), { clientY: 300 })
    movePointer(220)  // bar slot 6
    expect(row('ex2')).toHaveClass('drop-target-top')
    expect(row('ex1')).not.toHaveClass('drop-target-bottom')

    releasePointer(220)
    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'ex3', toIndex: 6 })

    const doc = makeDoc(wider, 6)
    applyReorderFeatures(doc, 'ex3', 6)
    expect(doc.features!.map(f => f.id)).toEqual(['Origin', 'Top', 'Front', 'Right', 'sk1', 'ex1', 'ex3', 'ex2'])
    expect(doc.rollback).toBe(6)
  })

  it('reorders when released inside the rollback bar band, not just its edge', () => {
    // The real bar is a li in the list flow: 10px plus 5px margins, so about 20px
    // between the rows either side of it. Model that band, not a zero-height
    // boundary.
    const onMutation = vi.fn()
    setupStore(features, 5)  // bar between sk1 (4) and ex1 (5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows({ barIndex: 5, barBand: 20 })

    pressRow(row('ex2'), { clientY: 280 })
    movePointer(210)  // the middle of the 200..220 band
    expect(row('ex1')).toHaveClass('drop-target-top')

    releasePointer(210)
    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'ex2', toIndex: 5 })
  })

  it('reorders into the tail with the bar parked at the end', () => {
    const onMutation = vi.fn()
    setupStore(features, null)  // bar at slot 7, after every row
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(340)  // the empty tail below the last row
    expect(row('ex2')).toHaveClass('drop-target-bottom')

    releasePointer(340)
    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'sk1', toIndex: 7 })
  })
})

describe('feature drag on touch', () => {
  it('does not start a drag from a swipe before the hold', () => {
    vi.useFakeTimers()
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180, pointerType: 'touch' })
    movePointer(230)
    releasePointer(230)

    expect(row('sk1')).not.toHaveClass('dragging')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('starts a drag after a long press and reorders on release', () => {
    vi.useFakeTimers()
    const onMutation = vi.fn()
    setupStore(features, 5)
    renderSidebar(makeCallbacks({ onMutation }))
    layoutFeatureRows()

    pressRow(row('sk1'), { clientY: 180, pointerType: 'touch' })
    act(() => { vi.advanceTimersByTime(350) })
    expect(row('sk1')).toHaveClass('dragging')

    movePointer(230)
    releasePointer(230)

    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'sk1', toIndex: 6 })
  })
})

describe('feature drag auto-scroll', () => {
  it('scrolls near the bottom edge and follows the rows into view', () => {
    const onMutation = vi.fn()
    const long = [...features, ex('ex3'), ex('ex4'), ex('ex5')]
    setupStore(long, null)  // bar at the end, so index 4 is the first draggable row
    renderSidebar(makeCallbacks({ onMutation }))

    const list = document.querySelector('.features-list') as HTMLElement
    let scrollTop = 0
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    })
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 240, height: 240, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: () => {},
    })
    list.querySelectorAll('.feature-item').forEach((el, i) => {
      vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => {
        const top = i * 40 - scrollTop
        return { top, bottom: top + 40, height: 40, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => {} }
      })
    })

    let frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    pressRow(row('sk1'), { clientY: 180 })
    movePointer(230)  // within 24px of the list's bottom edge
    expect(row('ex2')).toHaveClass('drop-target-top')

    act(() => {
      for (let frame = 0; frame < 5; frame++) {
        const callbacks = frames
        frames = []
        for (const cb of callbacks) cb(0)
      }
    })

    expect(scrollTop).toBe(40)
    expect(row('ex3')).toHaveClass('drop-target-top')

    releasePointer(230)
    expect(onMutation).toHaveBeenCalledWith({ type: 'reorder_features', featureId: 'sk1', toIndex: 7 })
  })
})
