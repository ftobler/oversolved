// @vitest-environment node
// The session history is pure stack arithmetic over document snapshots: no
// React, no store, so the suite runs in node against a plain object document.
import { describe, it, expect, vi } from 'vitest'
import { History } from '@/session/History'

interface Doc {
  label: string
  items: number[]
}

const doc = (label: string, items: number[] = []): Doc => ({ label, items })

const makeHistory = (cap = 50, cloneDoc: (d: Doc) => Doc = structuredClone) =>
  new History<Doc>({ cloneDoc, cap })

describe('mark and rollbackTo', () => {
  it('restores both stacks after a compound step pushed several entries', () => {
    const history = makeHistory()
    history.push('keep', doc('a'))
    history.push('undone', doc('b'))
    history.undo(doc('c'))
    const mark = history.mark()
    history.push('x', doc('d'))
    history.push('y', doc('e'))
    history.rollbackTo(mark)
    expect(history.undoLabels()).toEqual(['keep'])
    expect(history.redoLabels()).toEqual(['undone'])
  })

  it('restores a capped stack whose oldest entries the compound step dropped', () => {
    const history = makeHistory(3)
    for (const label of ['a', 'b', 'c']) history.push(label, doc(label))
    const mark = history.mark()
    history.push('x', doc('x'))
    history.push('y', doc('y'))
    expect(history.undoLabels()).toEqual(['c', 'x', 'y'])
    history.rollbackTo(mark)
    expect(history.undoLabels()).toEqual(['a', 'b', 'c'])
  })
})

describe('push, undo and redo', () => {
  it('round-trips a doc through undo and redo with its label', () => {
    const history = makeHistory()
    const a = doc('a')
    const b = doc('b')
    history.push('one', a)
    history.push('two', b)

    expect(history.undoLabels()).toEqual(['one', 'two'])
    expect(history.redoLabels()).toEqual([])

    expect(history.undo(b)).toEqual({ label: 'two', doc: b })
    expect(history.undoLabels()).toEqual(['one'])
    expect(history.redoLabels()).toEqual(['two'])

    expect(history.redo(a)).toEqual({ label: 'two', doc: b })
    expect(history.undoLabels()).toEqual(['one', 'two'])
    expect(history.redoLabels()).toEqual([])
  })

  it('undo and redo on an empty stack are null and change nothing', () => {
    const history = makeHistory()
    const a = doc('a')

    expect(history.undo(a)).toBeNull()
    expect(history.redo(a)).toBeNull()
    expect(history.undoLabels()).toEqual([])
    expect(history.redoLabels()).toEqual([])
  })

  it('does not move on an undo when only the redo branch is populated', () => {
    const history = makeHistory()
    history.push('one', doc('a'))
    history.undo(doc('a'))

    expect(history.undo(doc('a'))).toBeNull()
    expect(history.undoLabels()).toEqual([])
    expect(history.redoLabels()).toEqual(['one'])
  })

  it('a push clears the redo branch', () => {
    const history = makeHistory()
    history.push('one', doc('a'))
    history.undo(doc('a'))
    expect(history.redoLabels()).toEqual(['one'])

    history.push('two', doc('b'))
    expect(history.redoLabels()).toEqual([])
    expect(history.undoLabels()).toEqual(['two'])
  })

  it('keeps labels in push order, oldest first', () => {
    const history = makeHistory()
    history.push('first', doc('a'))
    history.push('second', doc('b'))
    history.push('third', doc('c'))

    expect(history.undoLabels()).toEqual(['first', 'second', 'third'])
    expect(history.undoLabels()).toEqual([...history.undoLabels()])
  })
})

describe('the cap', () => {
  it('drops the oldest entry once the cap is exceeded', () => {
    const history = makeHistory(3)
    for (let i = 0; i < 5; i++) history.push(`step ${i}`, doc(`d${i}`))

    expect(history.undoLabels()).toEqual(['step 2', 'step 3', 'step 4'])
    expect(history.undoLength() + history.redoLength()).toBeLessThanOrEqual(3)
  })

  it('conserves the pair across moves, never growing past the cap', () => {
    const history = makeHistory(3)
    for (let i = 0; i < 3; i++) history.push(`step ${i}`, doc(`d${i}`))

    history.undo(doc('live'))
    history.undo(doc('live'))
    history.redo(doc('live'))
    history.push('fresh', doc('live'))
    history.undo(doc('live'))
    history.undo(doc('live'))

    expect(history.undoLength() + history.redoLength()).toBeLessThanOrEqual(3)
  })

  it('drives past the real production cap of 50', () => {
    const history = makeHistory(50)
    for (let i = 0; i < 55; i++) history.push(`step ${i}`, doc(`d${i}`))

    expect(history.undoLength()).toBe(50)
    expect(history.undoLabels()[0]).toBe('step 5')
    expect(history.undoLabels().at(-1)).toBe('step 54')
  })
})

describe('the snapshot slot', () => {
  it('restore puts both stacks back and consumes the slot', () => {
    const history = makeHistory()
    history.push('kept', doc('a'))
    history.saveSnapshot()
    history.push('outside', doc('b'))

    expect(history.restoreSnapshot()).toBe(true)
    expect(history.undoLabels()).toEqual(['kept'])
    expect(history.redoLabels()).toEqual([])

    // The slot is single-use: a second restore has nothing left to put back.
    expect(history.restoreSnapshot()).toBe(false)
  })

  it('restores a parked redo branch as well', () => {
    const history = makeHistory()
    history.push('one', doc('a'))
    history.undo(doc('a'))
    history.saveSnapshot()
    history.push('two', doc('b'))

    expect(history.restoreSnapshot()).toBe(true)
    expect(history.undoLabels()).toEqual([])
    expect(history.redoLabels()).toEqual(['one'])
  })

  it('a second save clobbers the first restore point', () => {
    const history = makeHistory()
    history.push('a', doc('a'))
    history.saveSnapshot()
    history.push('b', doc('b'))
    history.saveSnapshot()
    history.push('c', doc('c'))

    history.restoreSnapshot()
    expect(history.undoLabels()).toEqual(['a', 'b'])
  })

  it('restoring without a save is inert', () => {
    const history = makeHistory()
    history.push('one', doc('a'))

    expect(history.restoreSnapshot()).toBe(false)
    expect(history.undoLabels()).toEqual(['one'])
  })

  it('undo or redo invalidates the saved restore point', () => {
    const history = makeHistory()
    history.push('one', doc('a'))
    history.saveSnapshot()
    history.undo(doc('a'))

    expect(history.restoreSnapshot()).toBe(false)
    expect(history.undoLabels()).toEqual([])
    expect(history.redoLabels()).toEqual(['one'])
  })

  it('clear drops both stacks and the slot', () => {
    const history = makeHistory()
    history.push('one', doc('a'))
    history.undo(doc('a'))
    history.push('two', doc('b'))
    history.saveSnapshot()

    history.clear()

    expect(history.undoLabels()).toEqual([])
    expect(history.redoLabels()).toEqual([])
    expect(history.restoreSnapshot()).toBe(false)
  })
})

describe('the clone policy', () => {
  it('push stores a clone, so a later mutation of the caller doc cannot rewrite history', () => {
    const history = makeHistory()
    const live = doc('a', [1])
    history.push('one', live)

    live.items.push(2)
    live.label = 'mutated'

    const aux = doc('live', [9])
    expect(history.undo(aux)).toEqual({ label: 'one', doc: { label: 'a', items: [1] } })
  })

  it('push clones once through the injected cloneDoc', () => {
    const clone = vi.fn((d: Doc): Doc => structuredClone(d))
    const history = makeHistory(50, clone)
    const live = doc('a')
    history.push('one', live)

    expect(clone).toHaveBeenCalledTimes(1)
    expect(clone).toHaveBeenCalledWith(live)
  })

  it('pushSnapshot trusts a caller-held snapshot instead of cloning again', () => {
    const clone = vi.fn((d: Doc): Doc => structuredClone(d))
    const history = makeHistory(50, clone)
    const snapshot = doc('a')
    history.pushSnapshot('one', snapshot)

    expect(clone).not.toHaveBeenCalled()
    expect(history.undo(doc('live'))).toEqual({ label: 'one', doc: snapshot })
  })

  it('the counterpart moved onto the opposite stack clones the departing doc', () => {
    const history = makeHistory()
    const atPush = doc('a', [1])
    history.push('one', atPush)

    // The live doc moved on since the push; the counterpart must snapshot the
    // doc actually being left behind, not the one the entry was built from.
    const live = doc('a', [1, 2])
    history.undo(live)
    // The counterpart was cloned at the move, so mutating the departing doc
    // afterwards must not rewrite what the redo restores.
    live.items.push(3)

    expect(history.redo(doc('a', [1]))).toEqual({ label: 'one', doc: { label: 'a', items: [1, 2] } })
  })
})
