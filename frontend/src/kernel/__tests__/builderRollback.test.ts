import { describe, it, expect } from 'vitest'
import { build } from '../builder'
import { makeDeps, makeTrackerDeps } from '../builderTestUtils'

// ─── rollback_position transition tests ───

describe('rollback transitions', () => {
  it('feature_order always contains the full feature list', () => {
    // BuildState.feature_order includes all features regardless of rollback_position.
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'sk2', kind: 'sketch' },
      { id: 'sk3', kind: 'sketch' },
    ]
    for (const rollback of [1, 2, 3]) {
      const r = build({ features }, { rollbackPosition: rollback }, makeDeps())
      expect(r._build_state.feature_order).toEqual(['sk1', 'sk2', 'sk3'])
    }
  })

  it('only solves features up to rollback_position', () => {
    // rollback_position=2 on a 4-feature stack only solves the first two.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
      { id: 'ex2', kind: 'extrude' },
    ]
    const r = build({ features }, { rollbackPosition: 2 }, deps)

    expect('sk1' in r.result).toBe(true)
    expect('ex1' in r.result).toBe(true)
    expect('sk2' in r.result).toBe(false)
    expect('ex2' in r.result).toBe(false)
    expect(r._build_state.feature_order).toEqual(['sk1', 'ex1', 'sk2', 'ex2'])
  })

  it('decreasing rollback reuses checkpoints for active features', () => {
    // Decreasing rollback from 3 to 2 reuses checkpoints for features before the cut.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const rFull = build({ features }, { rollbackPosition: 3 }, deps)
    const geomSk1Full = rFull.result.sk1

    const rRollback = build({ features }, { prevState: rFull._build_state, rollbackPosition: 2 }, deps)

    expect('sk1' in rRollback.result).toBe(true)
    expect('ex1' in rRollback.result).toBe(true)
    expect('sk2' in rRollback.result).toBe(false)
    expect(rRollback.result.sk1).toEqual(geomSk1Full)
    expect(rRollback.result.ex1).toEqual(rFull.result.ex1)
  })

  it('increasing rollback solves newly included features', () => {
    // Increasing rollback from 2 to 3 solves the newly included feature.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const rShort = build({ features }, { rollbackPosition: 2 }, deps)
    const rExtended = build({ features }, { prevState: rShort._build_state, rollbackPosition: 3 }, deps)

    expect('sk2' in rExtended.result).toBe(true)
    expect(rExtended.result.sk2).toMatchObject({ status: 'ok' })
    expect(rExtended.result.sk1).toEqual(rShort.result.sk1)
  })

  it('editing a feature beyond rollback does not dirty active features', () => {
    /**
     * Editing a feature past the rollback position does not invalidate checkpoints for features
     * before it.
     */
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const r1 = build({ features }, { rollbackPosition: 2 }, deps)
    const geomSk1 = r1.result.sk1

    // sk2 is beyond rollback; modifying it must not dirty sk1 or ex1.
    const features2 = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch', label: 'changed' },
    ]
    const r2 = build({ features: features2 }, { prevState: r1._build_state, rollbackPosition: 2 }, deps)

    expect(r2.result.sk1).toEqual(geomSk1)
    expect(r2.result.ex1).toMatchObject({ status: 'ok' })
    expect('sk2' in r2.result).toBe(false)
  })

  it('full build after partial rollback reuses all checkpoints', () => {
    // After a rollback=2 build, solving the full stack reuses checkpoints for sk1 and ex1.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const rPartial = build({ features }, { rollbackPosition: 2 }, deps)
    const geomSk1 = rPartial.result.sk1

    // Full build (no rollbackPosition) reuses checkpoints for active prefix.
    const rFull = build({ features }, { prevState: rPartial._build_state }, deps)

    expect(rFull.result.sk1).toEqual(geomSk1)
    expect(rFull.result.ex1).toEqual(rPartial.result.ex1)
    expect(rFull.result.sk2).toMatchObject({ status: 'ok' })
    expect(new Set(Object.keys(rFull.result as Record<string, unknown>))).toEqual(
      expect.objectContaining(new Set(['sk1', 'ex1', 'sk2']))
    )
  })

  it('same rollback position twice produces identical results', () => {
    // Solving at the same rollback position twice is stable.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const r1 = build({ features }, { rollbackPosition: 2 }, deps)
    const r2 = build({ features }, { prevState: r1._build_state, rollbackPosition: 2 }, deps)

    expect(r2.result.sk1).toEqual(r1.result.sk1)
    expect(r2.result.ex1).toEqual(r1.result.ex1)
  })

  it('undo/redo oscillation reuses checkpoints correctly each way', () => {
    // Simulate undo/redo: rollback 3->2->3 reuses checkpoints correctly each way.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const rFull = build({ features }, { rollbackPosition: 3 }, deps)
    const geomSk1 = rFull.result.sk1

    // Undo: rollback 3 -> 2
    const rUndo = build({ features }, { prevState: rFull._build_state, rollbackPosition: 2 }, deps)
    expect('sk2' in rUndo.result).toBe(false)
    expect(rUndo.result.sk1).toEqual(geomSk1)
    expect(rUndo.result.ex1).toMatchObject({ status: 'ok' })

    // Redo: rollback 2 -> 3
    const rRedo = build({ features }, { prevState: rUndo._build_state, rollbackPosition: 3 }, deps)
    expect(rRedo.result.sk2).toMatchObject({ status: 'ok' })
    expect(rRedo.result.sk1).toEqual(geomSk1)
  })
})
