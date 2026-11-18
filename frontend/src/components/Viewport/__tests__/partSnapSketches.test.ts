import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { partSnapSketches, PART_SNAP_FEAT_PREFIX } from '@/utils/geometry/partSnapProjection'
import { getPartsToRender } from '@/utils/partRender'
import type { Feature, PartResult } from '@/types/cad'

/**
 * Part snapping is a viewport promise: the cursor can land on what is drawn.
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
    partId: 'b1',
    mesh: {},
    edges: [],
    vertices: VERTICES,
    visible: true,
    ...overrides,
  } as Parameters<typeof partSnapSketches>[0][number]
}

describe('bodySnapSketches', () => {
  it('projects a drawn body under the sentinel feature id', () => {
    const out = partSnapSketches([item()], FRONT)
    expect(Object.keys(out)).toEqual([`${PART_SNAP_FEAT_PREFIX}b1`])
    expect(out[`${PART_SNAP_FEAT_PREFIX}b1`].bv0).toEqual({ x: 1, y: 2 })
  })

  it('skips a hidden body entirely', () => {
    expect(partSnapSketches([item({ visible: false })], FRONT)).toEqual({})
  })

  it('keeps the drawn body when a hidden one sits beside it', () => {
    const out = partSnapSketches([
      item({ partId: 'hidden', visible: false }),
      item({ partId: 'drawn' }),
    ], FRONT)
    expect(Object.keys(out)).toEqual([`${PART_SNAP_FEAT_PREFIX}drawn`])
  })

  it('skips a body with nothing to project', () => {
    expect(partSnapSketches([item({ vertices: undefined, edges: [] })], FRONT)).toEqual({})
  })

  it('a rolled-back body never reaches the helper through the render list', () => {
    // The rollback filter belongs to getBodiesToRender; this pins the pairing
    // the viewport uses, so a body past the bar contributes no snap targets.
    const features = [{ id: 'f1', kind: 'extrude' }, { id: 'f2', kind: 'extrude' }] as unknown as Feature[]
    const parts = {
      early: { created_by: 'f1', mesh: {}, vertices: VERTICES } as unknown as PartResult,
      late: { created_by: 'f2', mesh: {}, vertices: VERTICES } as unknown as PartResult,
    }
    const drawn = getPartsToRender(parts, features, 1, undefined)
    expect(drawn.map(i => i.partId)).toEqual(['early'])
    expect(Object.keys(partSnapSketches(drawn, FRONT))).toEqual([`${PART_SNAP_FEAT_PREFIX}early`])
  })

  // The helper is only half the promise; the viewport has to hand it the drawn
  // list. Feeding it the raw body map again would pass every test above, so the
  // wiring is pinned at both hops: the viewport hands snapSketchesFor its render
  // list, and that helper hands the same list to the projection.
  it('the viewport builds the snap set from bodyItems, not the raw body map', () => {
    const viewport = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')
    expect(viewport).toMatch(/snapSketchesFor\(/)
    expect(viewport).toMatch(/partItems,\s*\n\s*\)/)
    expect(viewport).not.toMatch(/bodySnapSketches\(\s*Object\.values\(/)

    const helper = readFileSync(join(__dirname, '..', 'partUtils.ts'), 'utf8')
    expect(helper).toMatch(/partSnapSketches\(partItems, planeTransform\)/)
  })
})
