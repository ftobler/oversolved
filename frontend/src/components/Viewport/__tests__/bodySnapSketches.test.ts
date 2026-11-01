import { describe, it, expect } from 'vitest'
import { bodySnapSketches, BODY_SNAP_FEAT_PREFIX } from '@/components/Geometry3D/bodySnapProjection'
import { getBodiesToRender } from '@/utils/bodyRender'
import type { Feature, BodyResult } from '@/types/cad'

/**
 * Body snapping is a viewport promise: the cursor can land on what is drawn.
 * The snap set used to be built from the raw body map, so a body hidden with
 * the visibility row -- or one the rollback bar has not reached -- still offered
 * vertices and edges to snap to, off screen. The helper is fed the render list
 * instead, and these tests pin that a body contributes only when it is drawn.
 */

const FRONT = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], origin: [0, 0, 0] as [number, number, number] }
const VERTICES: [number, number, number][] = [[1, 2, 0]]

function item(overrides: Record<string, unknown> = {}) {
  return {
    key: 'b1',
    featureId: 'f1',
    bodyId: 'b1',
    mesh: {},
    edges: [],
    vertices: VERTICES,
    visible: true,
    ...overrides,
  } as Parameters<typeof bodySnapSketches>[0][number]
}

describe('bodySnapSketches', () => {
  it('projects a drawn body under the sentinel feature id', () => {
    const out = bodySnapSketches([item()], FRONT)
    expect(Object.keys(out)).toEqual([`${BODY_SNAP_FEAT_PREFIX}b1`])
    expect(out[`${BODY_SNAP_FEAT_PREFIX}b1`].bv0).toEqual({ x: 1, y: 2 })
  })

  it('skips a hidden body entirely', () => {
    expect(bodySnapSketches([item({ visible: false })], FRONT)).toEqual({})
  })

  it('keeps the drawn body when a hidden one sits beside it', () => {
    const out = bodySnapSketches([
      item({ bodyId: 'hidden', visible: false }),
      item({ bodyId: 'drawn' }),
    ], FRONT)
    expect(Object.keys(out)).toEqual([`${BODY_SNAP_FEAT_PREFIX}drawn`])
  })

  it('skips a body with nothing to project', () => {
    expect(bodySnapSketches([item({ vertices: undefined, edges: [] })], FRONT)).toEqual({})
  })

  it('a rolled-back body never reaches the helper through the render list', () => {
    // The rollback filter belongs to getBodiesToRender; this pins the pairing
    // the viewport uses, so a body past the bar contributes no snap targets.
    const features = [{ id: 'f1', kind: 'extrude' }, { id: 'f2', kind: 'extrude' }] as unknown as Feature[]
    const bodies = {
      early: { created_by: 'f1', mesh: {}, vertices: VERTICES } as unknown as BodyResult,
      late: { created_by: 'f2', mesh: {}, vertices: VERTICES } as unknown as BodyResult,
    }
    const drawn = getBodiesToRender(bodies, features, 1, undefined)
    expect(drawn.map(i => i.bodyId)).toEqual(['early'])
    expect(Object.keys(bodySnapSketches(drawn, FRONT))).toEqual([`${BODY_SNAP_FEAT_PREFIX}early`])
  })
})
