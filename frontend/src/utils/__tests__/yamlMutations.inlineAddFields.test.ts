// The inline half of add_move_face, add_variable and add_helix: the appliers
// merge the accepted fields over their defaults, drop a key the def does not
// hold, and the dispatch table passes the remaining payload as `inline`. The
// real-kernel half, where one call must build the same solid as the old
// add + setter sequence, is drive/__tests__/inlineMoveFaceVariableHelixReal.
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddMoveFace,
  applyAddVariable,
  applyAddHelix,
} from '@/utils/yamlMutations'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { featureAt } from '@/testing/featureAccess'

function emptyDoc(): PartDoc {
  return { features: [] }
}

describe('applyAddMoveFace inline fields', () => {
  it('keeps the signed defaults with no inline payload', () => {
    const doc = emptyDoc()
    applyAddMoveFace(doc, 'mf1')
    expect(featureAt(doc, 0, 'move_face').move_face).toEqual({ faces: [], distance: 5 })
  })

  it('stores faces and distance in the same call', () => {
    const doc = emptyDoc()
    applyAddMoveFace(doc, 'mf1', 'My Move', { faces: ['?f1'], distance: 5 })
    expect(featureAt(doc, 0, 'move_face').move_face).toEqual({ faces: ['?f1'], distance: 5 })
    expect(doc.features![0].label).toBe('My Move')
  })

  it('takes an expression distance unchanged', () => {
    const doc = emptyDoc()
    applyAddMoveFace(doc, 'mf1', undefined, { distance: 'w / 4' })
    expect(featureAt(doc, 0, 'move_face').move_face.distance).toBe('w / 4')
  })

  it('copies the face list so a replay cannot share one array', () => {
    const faces = ['?f1']
    const doc = emptyDoc()
    applyAddMoveFace(doc, 'mf1', undefined, { faces })
    featureAt(doc, 0, 'move_face').move_face.faces.push('?f2')
    expect(faces).toEqual(['?f1'])
  })

  it('drops an unknown inline key', () => {
    const doc = emptyDoc()
    applyAddMoveFace(doc, 'mf1', undefined, { faces: ['?f1'], bogus: 1 } as never)
    expect(featureAt(doc, 0, 'move_face').move_face).toEqual({ faces: ['?f1'], distance: 5 })
  })

  it('passes the payload through the dispatch table', () => {
    const doc = emptyDoc()
    mutationHandlers.add_move_face(doc, {
      type: 'add_move_face', featureId: 'mf1', faces: ['?f1'], distance: -2,
    })
    expect(featureAt(doc, 0, 'move_face').move_face).toEqual({ faces: ['?f1'], distance: -2 })
  })
})

describe('applyAddVariable inline expression', () => {
  it('keeps the numeric default with no inline payload', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1')
    expect(doc.features).toEqual([
      { id: 'v1', kind: 'variable', label: 'var', variable: { expression: 0 } },
    ])
  })

  it('stores an inline expression under the sanitized label', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'my width', { expression: '40' })
    expect(doc.features).toEqual([
      { id: 'v1', kind: 'variable', label: 'my_width', variable: { expression: '40' } },
    ])
  })

  it('takes a numeric expression, the cached value and the unit', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'w', { expression: 40, value: 40, unit: 'mm' })
    expect(featureAt(doc, 0, 'variable').variable).toEqual({ expression: 40, value: 40, unit: 'mm' })
  })

  it('drops an unknown inline key', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'w', { expression: '40', bogus: 'x' } as never)
    expect(featureAt(doc, 0, 'variable').variable).toEqual({ expression: '40' })
  })

  it('passes the payload through the dispatch table', () => {
    const doc = emptyDoc()
    mutationHandlers.add_variable(doc, {
      type: 'add_variable', featureId: 'v1', label: 'w', expression: '40',
    })
    expect(featureAt(doc, 0, 'variable')).toMatchObject({ label: 'w', variable: { expression: '40' } })
  })
})

describe('applyAddHelix inline fields', () => {
  it('keeps every default with no inline payload', () => {
    const doc = emptyDoc()
    applyAddHelix(doc, 'hx1')
    expect(featureAt(doc, 0, 'helix').helix).toEqual({
      radius_mode: 'derived',
      mode: 'pitch_turns',
      pitch: 1,
      turns: 5,
      height: 5,
      helix_angle: 5,
      offset: 0,
      start_angle: 0,
      hand: 'right',
      direction: 'normal',
    })
  })

  it('stores the reference and the four setter values in one call', () => {
    const doc = emptyDoc()
    applyAddHelix(doc, 'hx1', undefined, {
      reference: '@ex1/face/0', mode: 'pitch_turns', pitch: 3, turns: 8, offset: 2,
    })
    expect(featureAt(doc, 0, 'helix').helix).toMatchObject({
      reference: '@ex1/face/0', mode: 'pitch_turns', pitch: 3, turns: 8, offset: 2,
    })
  })

  it('rounds a number the way the setter does and leaves an expression alone', () => {
    const doc = emptyDoc()
    applyAddHelix(doc, 'hx1', undefined, { pitch: 0.1 + 0.2, turns: 'n / 2' })
    expect(featureAt(doc, 0, 'helix').helix.pitch).toBe(0.3)
    expect(featureAt(doc, 0, 'helix').helix.turns).toBe('n / 2')
  })

  it('stamps auto_hidden on the feature row, not inside the helix def', () => {
    const doc = emptyDoc()
    applyAddHelix(doc, 'hx1', undefined, { reference: '@ex1/face/0', auto_hidden: true })
    const feature = featureAt(doc, 0, 'helix')
    expect(feature.auto_hidden).toBe(true)
    expect(feature.helix).not.toHaveProperty('auto_hidden')
  })

  it('refuses a helix angle the round lands on a degenerate end', () => {
    const doc = emptyDoc()
    applyAddHelix(doc, 'hx1', undefined, { helix_angle: 89.99999994 })
    expect(doc.features).toHaveLength(0)
  })

  it('drops an unknown inline key', () => {
    const doc = emptyDoc()
    applyAddHelix(doc, 'hx1', undefined, { turns: 8, bogus: 1 } as never)
    expect(featureAt(doc, 0, 'helix').helix).toEqual({
      radius_mode: 'derived',
      mode: 'pitch_turns',
      pitch: 1,
      turns: 8,
      height: 5,
      helix_angle: 5,
      offset: 0,
      start_angle: 0,
      hand: 'right',
      direction: 'normal',
    })
  })

  it('passes the payload through the dispatch table', () => {
    const doc = emptyDoc()
    mutationHandlers.add_helix(doc, {
      type: 'add_helix', featureId: 'hx1', reference: '@ex1/face/0',
      mode: 'pitch_turns', pitch: 3, turns: 8, offset: 2,
    })
    expect(featureAt(doc, 0, 'helix').helix).toMatchObject({
      reference: '@ex1/face/0', pitch: 3, turns: 8, offset: 2,
    })
  })
})
