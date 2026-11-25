import { describe, it, expect } from 'vitest'
import { describeEntryMove, planEntryMove, type EntryMovePlan, type MoveGraphEntry, type MoveSourceGraph, type MoveTargetGraph } from '../entryMove'

const doc = (id: string, name: string): MoveGraphEntry => ({ id, name, kind: 'document' })
const file = (id: string, name: string, contentHash = `h-${id}`): MoveGraphEntry => ({ id, name, kind: 'file', contentHash })

const EMPTY_TARGET: MoveTargetGraph = { name: 'Shop', entries: [], trash: [] }

function source(entries: MoveGraphEntry[], references: Record<string, string[]>, trash: string[] = []): MoveSourceGraph {
  return { entries, references, trash }
}

function ok(result: ReturnType<typeof planEntryMove>): EntryMovePlan {
  if (!result.ok) throw new Error(`expected a plan, got: ${result.refused}`)
  return result
}

// frame uses plate and stud; frame-2 uses stud too. Each part imports its STEP.
const SHOP = source(
  [
    doc('frame', 'frame'), doc('frame-2', 'frame-2'), doc('plate', 'plate'), doc('stud', 'stud'),
    file('plate.step', 'plate.step'), file('stud.step', 'stud.step'),
  ],
  {
    frame: ['plate', 'stud'],
    'frame-2': ['stud'],
    plate: ['plate.step'],
    stud: ['stud.step'],
  },
)

describe('planEntryMove', () => {
  it('moves a lone part together with its STEP file', () => {
    const plan = ok(planEntryMove(
      source([doc('p', 'bracket'), file('f', 'bracket.step')], { p: ['f'] }),
      'p', EMPTY_TARGET,
    ))
    expect(plan.move).toEqual(['p', 'f'])
    expect(plan.copy).toEqual([])
    expect(plan.files).toEqual(['f'])
    expect(plan.present).toEqual([])
  })

  it('refuses a part an assembly uses and names the assembly', () => {
    const result = planEntryMove(SHOP, 'plate', EMPTY_TARGET)
    expect(result).toEqual({
      ok: false,
      refused: 'plate is used by frame; move frame instead, or remove it from frame first.',
    })
  })

  it('names every live referrer when several use the entry', () => {
    const result = planEntryMove(SHOP, 'stud', EMPTY_TARGET)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.refused).toBe(
      'stud is used by frame and frame-2; move one of those instead, or remove it from them first.',
    )
  })

  it('lets a trashed referrer go, like the delete guard', () => {
    const graph = source([doc('a', 'frame'), doc('p', 'plate')], { a: ['p'] }, ['a'])
    expect(ok(planEntryMove(graph, 'p', EMPTY_TARGET)).move).toEqual(['p'])
  })

  it('moves an assembly with its exclusive part, copies the shared one, and lists all files', () => {
    const plan = ok(planEntryMove(SHOP, 'frame', EMPTY_TARGET))
    expect(plan.move).toEqual(['frame', 'plate', 'plate.step'])
    // stud stays for frame-2, and so does the file stud still imports.
    expect(plan.copy).toEqual(['stud', 'stud.step'])
    expect(plan.files.sort()).toEqual(['plate.step', 'stud.step'])
    expect(plan.sharedWith).toEqual({ stud: ['frame-2'], 'stud.step': ['stud'] })
  })

  it('copies a file a source part outside the move still imports', () => {
    const graph = source(
      [doc('a', 'frame'), doc('p', 'plate'), doc('q', 'loose'), file('f', 'shared.step')],
      { a: ['p'], p: ['f'], q: ['f'] },
    )
    const plan = ok(planEntryMove(graph, 'a', EMPTY_TARGET))
    expect(plan.move).toEqual(['a', 'p'])
    expect(plan.copy).toEqual(['f'])
  })

  // A move is a hard removal, unlike a delete: a trashed assembly restored later
  // would find a moved part gone for good, so a part it uses is copied.
  it('copies a member a trashed source entry still uses', () => {
    const graph = source(
      [doc('a', 'frame'), doc('old', 'old frame'), doc('p', 'plate')],
      { a: ['p'], old: ['p'] },
      ['old'],
    )
    const plan = ok(planEntryMove(graph, 'a', EMPTY_TARGET))
    expect(plan.move).toEqual(['a'])
    expect(plan.copy).toEqual(['p'])
    expect(plan.sharedWith).toEqual({ p: ['old frame (in the trash)'] })
  })

  // Discard brings the checkpoint's edges back, so a part another entry used at
  // the last save must still be there afterwards.
  it('copies a member another entry used at the last save', () => {
    const graph: MoveSourceGraph = {
      ...source([doc('a', 'frame'), doc('b', 'other'), doc('p', 'plate')], { a: ['p'] }),
      savedReferences: { a: ['p'], b: ['p'] },
    }
    const plan = ok(planEntryMove(graph, 'a', EMPTY_TARGET))
    expect(plan.copy).toEqual(['p'])
    expect(plan.sharedWith).toEqual({ p: ['other'] })
  })

  it('carries a nested assembly with its own parts', () => {
    const graph = source(
      [doc('top', 'top'), doc('sub', 'sub'), doc('p', 'pin')],
      { top: ['sub'], sub: ['p'] },
    )
    expect(ok(planEntryMove(graph, 'top', EMPTY_TARGET)).move).toEqual(['top', 'p', 'sub'])
  })

  it('leaves trashed and dangling references out of the closure', () => {
    const graph = source([doc('a', 'frame'), doc('p', 'plate')], { a: ['p', 'gone'] }, ['p'])
    const plan = ok(planEntryMove(graph, 'a', EMPTY_TARGET))
    expect(plan.move).toEqual(['a'])
    expect(plan.copy).toEqual([])
  })

  it('refuses an id the target already holds, by name', () => {
    const target: MoveTargetGraph = { name: 'Shop', entries: [doc('plate', 'plate')], trash: [] }
    expect(planEntryMove(SHOP, 'frame', target)).toEqual({
      ok: false, refused: 'Shop already has plate; delete it there first.',
    })
  })

  it('names a renamed earlier copy and a copy sitting in the target trash', () => {
    const target: MoveTargetGraph = { name: 'Shop', entries: [doc('plate', 'old plate')], trash: ['plate'] }
    expect(planEntryMove(SHOP, 'frame', target)).toEqual({
      ok: false, refused: 'Shop already has old plate (an earlier copy of plate) in its trash; delete it there first.',
    })
  })

  it('reuses a byte-identical file the target already holds', () => {
    const target: MoveTargetGraph = { name: 'Shop', entries: [file('plate.step', 'plate.step')], trash: [] }
    const plan = ok(planEntryMove(SHOP, 'frame', target))
    expect(plan.present).toEqual(['plate.step'])
    expect(plan.move).toContain('plate.step')
  })

  it('refuses a same-id file whose bytes differ', () => {
    const target: MoveTargetGraph = { name: 'Shop', entries: [file('plate.step', 'plate.step', 'other')], trash: [] }
    expect(planEntryMove(SHOP, 'frame', target).ok).toBe(false)
  })

  it('refuses a file row and a trashed entry', () => {
    expect(planEntryMove(SHOP, 'plate.step', EMPTY_TARGET)).toEqual({
      ok: false, refused: 'plate.step is a file; files move with the documents that use them.',
    })
    const trashed = source([doc('p', 'plate')], {}, ['p'])
    expect(planEntryMove(trashed, 'p', EMPTY_TARGET).ok).toBe(false)
  })
})

describe('describeEntryMove', () => {
  const names = new Map(SHOP.entries.map(row => [row.id, row.name]))
  const nameOf = (id: string) => names.get(id) ?? id

  it('lists the parts that travel and says which one is copied', () => {
    const plan = ok(planEntryMove(SHOP, 'frame', EMPTY_TARGET))
    expect(describeEntryMove(plan, nameOf)).toBe('Move frame with plate and stud (stud is also used by frame-2 and is copied).')
  })

  it('joins several copied parts and several sharers', () => {
    const graph = source(
      [doc('a', 'frame'), doc('b', 'rack'), doc('c', 'cart'), doc('p', 'pin'), doc('q', 'stud')],
      { a: ['p', 'q'], b: ['p', 'q'], c: ['q'] },
    )
    const names = new Map(graph.entries.map(row => [row.id, row.name]))
    const plan = ok(planEntryMove(graph, 'a', EMPTY_TARGET))
    expect(describeEntryMove(plan, id => names.get(id) ?? id)).toBe(
      'Move frame with pin and stud (pin is also used by rack and is copied; stud is also used by cart and rack and is copied).',
    )
  })

  it('needs no confirm when only the entry and its own files travel', () => {
    const plan = ok(planEntryMove(source([doc('p', 'bracket'), file('f', 'bracket.step')], { p: ['f'] }), 'p', EMPTY_TARGET))
    expect(describeEntryMove(plan, nameOf)).toBeNull()
  })
})
