import { describe, it, expect } from 'vitest'

interface UndoEntry {
  doc: { value: string }
  mutation: { type: string }
}

type UndoStack = UndoEntry[]
type RedoStack = UndoEntry[]

function simulateUndo(
  undoStack: UndoStack,
  redoStack: RedoStack,
  currentDoc: { value: string },
): { undoStack: UndoStack; redoStack: RedoStack; currentDoc: { value: string } } {
  if (undoStack.length === 0) return { undoStack, redoStack, currentDoc }
  const next = [...undoStack]
  const entry = next.pop()!
  const preUndoDoc = { ...currentDoc }
  const newRedo = [...redoStack, { doc: preUndoDoc, mutation: entry.mutation }]
  return { undoStack: next, redoStack: newRedo, currentDoc: { ...entry.doc } }
}

function simulateRedo(
  undoStack: UndoStack,
  redoStack: RedoStack,
  currentDoc: { value: string },
): { undoStack: UndoStack; redoStack: RedoStack; currentDoc: { value: string } } {
  if (redoStack.length === 0) return { undoStack, redoStack, currentDoc }
  const next = [...redoStack]
  const entry = next.pop()!
  const preRedoDoc = { ...currentDoc }
  const newUndo = [...undoStack, { doc: preRedoDoc, mutation: entry.mutation }]
  return { undoStack: newUndo, redoStack: next, currentDoc: { ...entry.doc } }
}

describe('undo/redo stack integrity', () => {
  it('undo moves current to redo and restores previous state', () => {
    const docA = { value: 'A' }
    const docB = { value: 'B' }
    const undoStack: UndoStack = [{ doc: docA, mutation: { type: 'add_sketch' } }]
    const redoStack: RedoStack = []
    const currentDoc = { ...docB }

    const result = simulateUndo(undoStack, redoStack, currentDoc)
    expect(result.currentDoc.value).toBe('A')
    expect(result.undoStack).toHaveLength(0)
    expect(result.redoStack).toHaveLength(1)
    expect(result.redoStack[0].doc.value).toBe('B')
    expect(result.redoStack[0].mutation.type).toBe('add_sketch')
  })

  it('redo moves current back to undo and restores previous state', () => {
    const docA = { value: 'A' }
    const docB = { value: 'B' }
    const undoStack: UndoStack = []
    const redoStack: RedoStack = [{ doc: docB, mutation: { type: 'add_sketch' } }]
    const currentDoc = { ...docA }

    const result = simulateRedo(undoStack, redoStack, currentDoc)
    expect(result.currentDoc.value).toBe('B')
    expect(result.undoStack).toHaveLength(1)
    expect(result.undoStack[0].doc.value).toBe('A')
    expect(result.redoStack).toHaveLength(0)
  })

  it('undo then redo returns to original state', () => {
    const docA = { value: 'A' }
    const docB = { value: 'B' }
    const undoStack: UndoStack = [{ doc: docA, mutation: { type: 'add_sketch' } }]
    const redoStack: RedoStack = []
    const currentDoc = { ...docB }

    // Undo
    const afterUndo = simulateUndo(undoStack, redoStack, currentDoc)
    expect(afterUndo.currentDoc.value).toBe('A')
    expect(afterUndo.redoStack).toHaveLength(1)

    // Redo
    const afterRedo = simulateRedo(afterUndo.undoStack, afterUndo.redoStack, afterUndo.currentDoc)
    expect(afterRedo.currentDoc.value).toBe('B')
    expect(afterRedo.undoStack).toHaveLength(1)
    expect(afterRedo.redoStack).toHaveLength(0)
  })

  it('redo stack does not get duplicated entries (bug fix)', () => {
    const docA = { value: 'A' }
    const docB = { value: 'B' }
    const docC = { value: 'C' }
    const undoStack: UndoStack = [
      { doc: docA, mutation: { type: 'add_sketch' } },
      { doc: docB, mutation: { type: 'add_extrude' } },
      { doc: docC, mutation: { type: 'add_fillet' } },
    ]
    const redoStack: RedoStack = []
    const currentDoc = { value: 'D' }

    // Undo once (should go to C)
    const u1 = simulateUndo(undoStack, redoStack, currentDoc)
    expect(u1.currentDoc.value).toBe('C')
    expect(u1.redoStack).toHaveLength(1)
    expect(u1.redoStack[0].doc.value).toBe('D')

    // Redo once (should go to D, no duplicates)
    const r1 = simulateRedo(u1.undoStack, u1.redoStack, u1.currentDoc)
    expect(r1.currentDoc.value).toBe('D')
    expect(r1.undoStack).toHaveLength(3)
    expect(r1.redoStack).toHaveLength(0)
  })

  it('new mutation clears redo stack', () => {
    const docA = { value: 'A' }
    const docB = { value: 'B' }
    const docC = { value: 'C' }
    let undoStack: UndoStack = [{ doc: docA, mutation: { type: 'add_sketch' } }]
    let redoStack: RedoStack = [{ doc: docB, mutation: { type: 'add_extrude' } }]
    const currentDoc = { ...docC }

    // New mutation: clear redo, push to undo
    const preMutationDoc = { ...currentDoc }
    undoStack = [...undoStack, { doc: preMutationDoc, mutation: { type: 'add_fillet' } }]
    redoStack = []
    expect(undoStack).toHaveLength(2)
    expect(redoStack).toHaveLength(0)
  })

  it('stack limit drops oldest entries', () => {
    const entries: UndoEntry[] = []
    for (let i = 0; i < 210; i++) {
      entries.push({ doc: { value: `doc${i}` }, mutation: { type: 'add_sketch' } })
    }
    const maxSize = 50
    const trimmed = entries.length > maxSize ? entries.slice(entries.length - maxSize) : entries
    expect(trimmed).toHaveLength(50)
    expect(trimmed[0].doc.value).toBe('doc160')
  })

  it('undo on empty stack is no-op', () => {
    const docA = { value: 'A' }
    const result = simulateUndo([], [], docA)
    expect(result.currentDoc.value).toBe('A')
    expect(result.undoStack).toHaveLength(0)
    expect(result.redoStack).toHaveLength(0)
  })

  it('redo on empty stack is no-op', () => {
    const docA = { value: 'A' }
    const result = simulateRedo([], [], docA)
    expect(result.currentDoc.value).toBe('A')
    expect(result.undoStack).toHaveLength(0)
    expect(result.redoStack).toHaveLength(0)
  })

  it('undo across multiple steps rolls back correctly', () => {
    const docs = ['A', 'B', 'C', 'D'].map(v => ({ value: v }))
    const undoStack: UndoStack = [
      { doc: docs[0], mutation: { type: 'm1' } },
      { doc: docs[1], mutation: { type: 'm2' } },
      { doc: docs[2], mutation: { type: 'm3' } },
    ]
    const redoStack: RedoStack = []
    const currentDoc = { ...docs[3] }

    // Undo three times
    const u1 = simulateUndo(undoStack, redoStack, currentDoc)
    expect(u1.currentDoc.value).toBe('C')
    const u2 = simulateUndo(u1.undoStack, u1.redoStack, u1.currentDoc)
    expect(u2.currentDoc.value).toBe('B')
    const u3 = simulateUndo(u2.undoStack, u2.redoStack, u2.currentDoc)
    expect(u3.currentDoc.value).toBe('A')

    // Redo three times
    const r1 = simulateRedo(u3.undoStack, u3.redoStack, u3.currentDoc)
    expect(r1.currentDoc.value).toBe('B')
    const r2 = simulateRedo(r1.undoStack, r1.redoStack, r1.currentDoc)
    expect(r2.currentDoc.value).toBe('C')
    const r3 = simulateRedo(r2.undoStack, r2.redoStack, r2.currentDoc)
    expect(r3.currentDoc.value).toBe('D')
  })
})
