import { describe, it, expect } from 'vitest'
import { HighlightIndex } from '../selectionHighlight'
import { hoverActiveFrom, selectActiveFrom } from '../highlightActive'
import { bodyKeyFor, primitivePickKey } from '../pickKey'
import { FACE_LAYER_NAME } from '../layerNames'

/**
 * Hover is global state: one `hoveredSelectionId` write re-renders EVERY Body3D
 * in the scene. What must not follow from that re-render is per-body work --
 * Body3D turns its highlight flags into a per-triangle colour buffer and uploads
 * it to the GPU, so a body whose flags did not actually change has to come out of
 * its memos untouched, by reference.
 *
 * This mirrors Body3D's memo chain (one HighlightIndex per body/layer, fed the
 * active sets the store builders produce) and asserts the property the memos
 * depend on. Without it, moving the pointer over one part rebuilt and re-uploaded
 * the colour buffer of every part in the model.
 */
describe('highlight flags stay reference-stable for uninvolved bodies', () => {
  const FACES_PER_BODY = 400
  const bodies = Array.from({ length: 20 }, (_, b) => {
    const bodyKey = bodyKeyFor(`extrude${b}`, 'body0')
    const queries = Array.from({ length: FACES_PER_BODY }, (_, i) => `face@createdBy=extrude${b}#${i}`)
    return { bodyKey, queries, index: new HighlightIndex(bodyKey, FACE_LAYER_NAME, queries) }
  })

  // What a memo keyed on the flags array would see: it re-runs only on a new reference.
  const memoWouldRerun = (before: readonly boolean[], after: readonly boolean[]) => before !== after

  it('a hover walking across the scene only re-runs the body under the pointer', () => {
    let flags = bodies.map(b => b.index.compute(hoverActiveFrom(null, null)))

    for (const pointed of [3, 7, 19, 0]) {
      const active = hoverActiveFrom(
        primitivePickKey(bodies[pointed].bodyKey, 5, FACE_LAYER_NAME),
        bodies[pointed].queries[5],
      )
      const next = bodies.map(b => b.index.compute(active))
      const rerun = next.map((f, i) => memoWouldRerun(flags[i], f))

      // Exactly the newly pointed body (and, on the previous iteration's body,
      // the return to all-false) may re-run. Every other body is untouched.
      expect(rerun[pointed]).toBe(true)
      expect(next[pointed][5]).toBe(true)
      expect(rerun.filter(Boolean).length).toBeLessThanOrEqual(2)
      flags = next
    }
  })

  it('an unrelated hover returns the identical all-false array, not a fresh one', () => {
    const [a, b] = bodies
    const first = a.index.compute(hoverActiveFrom(
      primitivePickKey(b.bodyKey, 1, FACE_LAYER_NAME), b.queries[1]))
    const second = a.index.compute(hoverActiveFrom(
      primitivePickKey(b.bodyKey, 2, FACE_LAYER_NAME), b.queries[2]))
    expect(first).toBe(second)
    expect(a.index.hasAny(first)).toBe(false)
  })

  it('a growing selection elsewhere leaves an unselected body stable', () => {
    const [a, ...rest] = bodies
    const picks = new Map<string, Set<string>>()
    const selection = new Set<string>()
    let flags = a.index.compute(selectActiveFrom(picks, selection))

    for (const other of rest) {
      selection.add(other.queries[0])
      picks.set(other.queries[0], new Set([primitivePickKey(other.bodyKey, 0, FACE_LAYER_NAME)]))
      const next = a.index.compute(selectActiveFrom(picks, selection))
      expect(memoWouldRerun(flags, next)).toBe(false)
      flags = next
    }

    // ...and the body still answers correctly once it IS selected.
    selection.add(a.queries[9])
    picks.set(a.queries[9], new Set([primitivePickKey(a.bodyKey, 9, FACE_LAYER_NAME)]))
    const mine = a.index.compute(selectActiveFrom(picks, selection))
    expect(memoWouldRerun(flags, mine)).toBe(true)
    expect(mine[9]).toBe(true)
    expect(mine.filter(Boolean).length).toBe(1)
  })
})
