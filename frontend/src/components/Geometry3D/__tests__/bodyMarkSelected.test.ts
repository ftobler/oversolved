// The body mark's one selection decision (bug: delete-part-preview-color).
// A pick chip copies the values it holds into the normal selection, so during
// an armed Delete Part the doomed body is selected on paper. That mirror must
// not outrank the removal mark, or the preview's pink wireframe turns white.
import { describe, it, expect } from 'vitest'
import { bodyMarkSelected } from '@/components/Geometry3D/constants'

const BODY = 'body_ex1'
const BODY_ID = '@' + BODY

const selected = (normal: string[], chip: string[] = [], doomed = false) => bodyMarkSelected({
  bodyId: BODY,
  normalSelection: new Set(normal),
  chipOwnedSelection: new Set(chip),
  doomed,
})

describe('bodyMarkSelected', () => {
  it('is not selected when nothing names the body', () => {
    expect(selected([])).toBe(false)
  })

  it('is selected by a plain click', () => {
    expect(selected([BODY_ID])).toBe(true)
  })

  it('is not selected by a pick chip mirror on a doomed body', () => {
    // The reported bug: creating a Delete Part arms its Parts chip, the chip
    // mirrors its value into normalSelection, and the doomed body went white
    // instead of the removal pink.
    expect(selected([BODY_ID], [BODY_ID], true)).toBe(false)
  })

  it('is selected again when the user clicks a doomed body', () => {
    // A real click is never chip-owned, so the bright wireframe that says
    // "click again to un-pick" still works.
    expect(selected([BODY_ID], [], true)).toBe(true)
  })

  it('still counts a chip mirror on a body the edit is not removing', () => {
    // Unchanged for every other chip: a boolean's merge-target chip lights up
    // its part while the field is armed.
    expect(selected([BODY_ID], [BODY_ID])).toBe(true)
  })

  it('ignores a chip-owned id that is not this body', () => {
    expect(selected([BODY_ID], ['@body_ex2'], true)).toBe(true)
  })
})
