// The editor half of the sketch clipboard: native copy/paste events, the
// editable-target pass-through, the selection hand-off after a paste, the
// feature-mode hint, and the "browser owns Ctrl+C/V" keyboard rule. A paste is
// one onMutation call, so the session makes it one undo entry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { Mutation, PartDoc, SketchData } from '@/types/cad'
import { useSketchClipboard } from '@/hooks/useSketchClipboard'
import { useEditorState } from '@/hooks/useEditorState'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { buildSketchClip, parseClip, serializeClip } from '@/utils/clipboard/sketchClipboard'
import { dispatchKey } from '@/hooks/commandRegistry'
import { okResult, type Result } from '@/session/result'

const DOC: PartDoc = makeDoc(makeSketch('sk1', {
  entities: [{ id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }],
  initial: { l1: [0, 0, 10, 0], l2: [0, 5, 10, 5] },
  constraints: [{ id: 'c1', kind: 'horizontal', target: '$l1' }],
}))

function clipText(): string {
  const feature = DOC.features![0]
  if (feature.kind !== 'sketch') throw new Error('fixture is not a sketch')
  const built = buildSketchClip(feature, ['l1', 'l2'])
  if ('reason' in built) throw new Error(built.reason)
  return serializeClip(built.clip)
}

interface HarnessProps {
  doc: PartDoc | null
  solveResults?: Record<string, SketchData>
  onMutation: (m: Mutation) => Result | null
  notify: (message: string, severity?: string) => void
}

function Harness({ doc, solveResults = {}, onMutation, notify }: HarnessProps) {
  useSketchClipboard({ doc, solveResults, onMutation, notify })
  return <input data-testid="text" />
}

function mount(overrides: Partial<HarnessProps> = {}) {
  const props: HarnessProps = {
    doc: DOC,
    onMutation: vi.fn(() => okResult([])),
    notify: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<Harness {...props} />) }
}

function copyEvent(target: EventTarget = document): { event: Event; text: () => string } {
  let stored = ''
  const event = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (_type: string, value: string) => { stored = value },
      getData: () => stored,
    },
  })
  target.dispatchEvent(event)
  return { event, text: () => stored }
}

function pasteEvent(text: string, target: EventTarget = document): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text, setData: () => {} } })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  useEditorState.setState({
    activeFeatureId: null,
    normalSelection: new Set(),
    drawHover: null,
    chipOwnedSelection: new Set(),
    activeTool: null,
    modeStack: [],
  })
})

afterEach(cleanup)

describe('useSketchClipboard copy', () => {
  it('copies the selected sketch entities as a clip and says what was broken', () => {
    act(() => {
      useEditorState.setState({
        activeFeatureId: 'sk1',
        normalSelection: new Set(['entity:sk1:l1', 'entity:sk1:l2']),
      })
    })
    const notify = vi.fn()
    const onMutation = vi.fn(() => okResult([]))
    mount({ notify, onMutation })
    const { event, text } = copyEvent()
    expect(event.defaultPrevented).toBe(true)
    const parsed = parseClip(text())
    expect('reason' in parsed).toBe(false)
    if ('reason' in parsed) return
    expect(parsed.entities.map(e => e.id)).toEqual(['l1', 'l2'])
    expect(parsed.constraints.map(c => c.id)).toEqual(['c1'])
    expect(notify).toHaveBeenCalledWith('Copied 2 entities and 1 constraint.', 'info')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('leaves the browser alone when focus is in a text input', () => {
    act(() => {
      useEditorState.setState({
        activeFeatureId: 'sk1',
        normalSelection: new Set(['entity:sk1:l1']),
      })
    })
    const notify = vi.fn()
    const { getByTestId } = mount({ notify })
    const input = getByTestId('text')
    input.focus()
    const { event } = copyEvent(input)
    expect(event.defaultPrevented).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('does nothing with an empty selection, so the browser default runs', () => {
    act(() => useEditorState.setState({ activeFeatureId: 'sk1' }))
    const notify = vi.fn()
    mount({ notify })
    const { event } = copyEvent()
    expect(event.defaultPrevented).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('useSketchClipboard paste', () => {
  it('dispatches one paste mutation and selects the new entities', () => {
    act(() => useEditorState.setState({ activeFeatureId: 'sk1' }))
    const onMutation = vi.fn((_m: Mutation) => okResult(['n1', 'n2']))
    mount({ onMutation })
    const event = pasteEvent(clipText())
    expect(event.defaultPrevented).toBe(true)
    expect(onMutation).toHaveBeenCalledTimes(1)
    const mutation = onMutation.mock.calls[0][0] as unknown as { type: string; featureId: string; clip: unknown; offset: number[] }
    expect(mutation.type).toBe('paste_sketch_entities')
    expect(mutation.featureId).toBe('sk1')
    expect(mutation.offset.every(Number.isFinite)).toBe(true)
    expect([...useEditorState.getState().normalSelection].sort()).toEqual(['entity:sk1:n1', 'entity:sk1:n2'])
  })

  it('shows the error toast for text that is not a clip and dispatches nothing', () => {
    act(() => useEditorState.setState({ activeFeatureId: 'sk1' }))
    const notify = vi.fn()
    const onMutation = vi.fn(() => okResult([]))
    mount({ notify, onMutation })
    const event = pasteEvent('hello world')
    expect(event.defaultPrevented).toBe(true)
    expect(onMutation).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('The clipboard does not hold Oversolved sketch geometry.', 'error')
  })

  it('points a feature-mode paste at opening a sketch', () => {
    const notify = vi.fn()
    const onMutation = vi.fn(() => okResult([]))
    mount({ notify, onMutation })
    const event = pasteEvent(clipText())
    expect(event.defaultPrevented).toBe(true)
    expect(onMutation).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('Open a sketch to paste sketch geometry.', 'error')
  })

  it('leaves a text-input paste to the browser', () => {
    act(() => useEditorState.setState({ activeFeatureId: 'sk1' }))
    const notify = vi.fn()
    const onMutation = vi.fn(() => okResult([]))
    const { getByTestId } = mount({ notify, onMutation })
    const input = getByTestId('text')
    input.focus()
    const event = pasteEvent(clipText(), input)
    expect(event.defaultPrevented).toBe(false)
    expect(onMutation).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('steps two pastes at the same cursor apart', () => {
    act(() => useEditorState.setState({ activeFeatureId: 'sk1' }))
    const offsets: number[][] = []
    const onMutation = vi.fn((m: Mutation) => {
      if (m.type === 'paste_sketch_entities') offsets.push(m.offset ?? [])
      return okResult(['n1', 'n2'])
    })
    mount({ onMutation })
    pasteEvent(clipText())
    pasteEvent(clipText())
    expect(offsets).toHaveLength(2)
    expect(offsets[0]).not.toEqual(offsets[1])
  })
})

describe('the keyboard leaves Ctrl+C / Ctrl+V to the browser', () => {
  it('dispatches neither key and never preventDefaults it', () => {
    for (const key of ['c', 'v']) {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true })
      expect(dispatchKey(event)).toBe(false)
      expect(event.defaultPrevented).toBe(false)
    }
  })
})
