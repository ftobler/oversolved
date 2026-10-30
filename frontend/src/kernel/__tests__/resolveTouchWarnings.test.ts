// The post-solve resolution pass for the "the new solid also touches ..." family.
// Synthetic checkpoints keep this a pure unit test: the pass reads body ids and
// each feature's result row, so the geometry never has to be real. The result
// dict carries EVERY feature row, as the builder hands it over.

import { describe, it, expect } from 'vitest'
import type { Body } from '../types3d'
import { resolveTouchWarnings } from '../resolveTouchWarnings'

type Row = Record<string, unknown>
type Checkpoints = Record<string, { result: Row; body_store_snapshot: Record<string, Body> }>

function store(...ids: string[]): Record<string, Body> {
  return Object.fromEntries(ids.map((id) => [id, { id } as Body]))
}

/** Every checkpoint's result row, cloned, as the builder's top-level result. */
function rows(checkpoints: Checkpoints): Record<string, Row> {
  return Object.fromEntries(Object.entries(checkpoints).map(([id, cp]) => [id, { ...cp.result }]))
}

const touch = (names: string): string =>
  `extrude: the new solid also touches ${names}; add a boolean union to fuse it`

function base(): Checkpoints {
  return {
    ex1: { result: { status: 'ok', body_id: 'body_a' }, body_store_snapshot: store('body_a') },
    ex2: { result: { status: 'ok', body_id: 'body_b' }, body_store_snapshot: store('body_a', 'body_b') },
    ex3: {
      result: { status: 'ok', body_id: 'body_a', operation: 'add', solver_warning: touch('body_b') },
      body_store_snapshot: store('body_a', 'body_b'),
    },
  }
}

describe('resolveTouchWarnings', () => {
  it('moves a warning to resolved_warning when a union fused every named body', () => {
    const order = ['ex1', 'ex2', 'ex3', 'bo1']
    const checkpoints: Checkpoints = {
      ...base(),
      bo1: {
        result: { status: 'ok', body_id: 'body_a', operation: 'union' },
        body_store_snapshot: store('body_a'),
      },
    }
    const result = rows(checkpoints)

    resolveTouchWarnings(order, checkpoints, result)

    expect(result.ex3).not.toHaveProperty('solver_warning')
    expect(result.ex3.resolved_warning).toBe(touch('body_b'))
    // The checkpoint row is a cached per-feature boundary; the pass must not
    // write the resolution into it.
    expect(checkpoints.ex3.result.solver_warning).toBe(touch('body_b'))
  })

  it('leaves the warning alone when the bodies stay separate', () => {
    const order = ['ex1', 'ex2', 'ex3']
    const checkpoints = base()
    const result = rows(checkpoints)

    resolveTouchWarnings(order, checkpoints, result)

    expect(result.ex3.solver_warning).toBe(touch('body_b'))
    expect(result.ex3).not.toHaveProperty('resolved_warning')
  })

  it('rewrites the text to name only the bodies still apart', () => {
    const order = ['ex1', 'ex2', 'ex3', 'ex4', 'bo1']
    const checkpoints: Checkpoints = {
      ex1: { result: { status: 'ok', body_id: 'body_a' }, body_store_snapshot: store('body_a') },
      ex2: { result: { status: 'ok', body_id: 'body_b' }, body_store_snapshot: store('body_a', 'body_b') },
      ex3: { result: { status: 'ok', body_id: 'body_c' }, body_store_snapshot: store('body_a', 'body_b', 'body_c') },
      ex4: {
        result: { status: 'ok', body_id: 'body_a', operation: 'add', solver_warning: touch('body_b, body_c') },
        body_store_snapshot: store('body_a', 'body_b', 'body_c'),
      },
      bo1: {
        result: { status: 'ok', body_id: 'body_a', operation: 'union' },
        body_store_snapshot: store('body_a', 'body_c'),
      },
    }
    const result = rows(checkpoints)

    resolveTouchWarnings(order, checkpoints, result)

    expect(result.ex4.solver_warning).toBe(touch('body_c'))
    expect(result.ex4).not.toHaveProperty('resolved_warning')
  })

  it('keeps the warning when a union split into siblings instead of fusing', () => {
    // boolean.ts runs every union through resplitBody, so a union of disjoint
    // bodies leaves the tool's material as a sibling of the target. The touched
    // body is still separate and the warning must survive.
    const order = ['ex1', 'ex2', 'ex3', 'bo1']
    const checkpoints: Checkpoints = {
      ...base(),
      bo1: {
        result: { status: 'ok', body_id: 'body_a', body_ids: ['body_a', 'body_a_1'], operation: 'union' },
        body_store_snapshot: store('body_a', 'body_a_1'),
      },
    }
    const result = rows(checkpoints)

    resolveTouchWarnings(order, checkpoints, result)

    expect(result.ex3.solver_warning).toBe(touch('body_b'))
    expect(result.ex3).not.toHaveProperty('resolved_warning')
  })

  it('follows a body consumed through several unions', () => {
    const order = ['ex1', 'ex2', 'ex3', 'bo1', 'bo2']
    const checkpoints: Checkpoints = {
      ...base(),
      bo1: {
        result: { status: 'ok', body_id: 'body_tmp', operation: 'union' },
        body_store_snapshot: store('body_a', 'body_tmp'),
      },
      bo2: {
        result: { status: 'ok', body_id: 'body_a', operation: 'union' },
        body_store_snapshot: store('body_a'),
      },
    }
    const result = rows(checkpoints)

    resolveTouchWarnings(order, checkpoints, result)

    expect(result.ex3).not.toHaveProperty('solver_warning')
    expect(result.ex3.resolved_warning).toBe(touch('body_b'))
  })

  it('resolves a named body a non-fusion operation removed', () => {
    const order = ['ex1', 'ex2', 'ex3', 'cut1']
    const checkpoints: Checkpoints = {
      ...base(),
      cut1: {
        result: { status: 'ok', body_id: 'body_a', operation: 'cut' },
        body_store_snapshot: store('body_a'),
      },
    }
    const result = rows(checkpoints)

    resolveTouchWarnings(order, checkpoints, result)

    expect(result.ex3).not.toHaveProperty('solver_warning')
    expect(result.ex3.resolved_warning).toBe(touch('body_b'))
  })

  it('keeps an unrelated warning beside the resolved one', () => {
    const order = ['ex1', 'ex2', 'ex3', 'bo1']
    const other = 'extrude: add joined nothing (the profile shares no volume with an existing body)'
    const baseRows = base()
    const checkpoints: Checkpoints = {
      ...baseRows,
      ex3: {
        result: { ...baseRows.ex3.result, solver_warning: `${other}; ${touch('body_b')}` },
        body_store_snapshot: store('body_a', 'body_b'),
      },
      bo1: {
        result: { status: 'ok', body_id: 'body_a', operation: 'union' },
        body_store_snapshot: store('body_a'),
      },
    }
    const result = rows(checkpoints)

    resolveTouchWarnings(order, checkpoints, result)

    expect(result.ex3.solver_warning).toBe(other)
    expect(result.ex3.resolved_warning).toBe(touch('body_b'))
  })

  it('replaces the result row instead of mutating a cached checkpoint row', () => {
    // On an incremental rebuild a clean-prefix feature's top-level row IS the
    // checkpoint's cached object (builder.ts assigns it directly). Resolving it
    // in place would bake this build's answer into a row a later build restores.
    const order = ['ex1', 'ex2', 'ex3', 'bo1']
    const checkpoints: Checkpoints = {
      ...base(),
      bo1: {
        result: { status: 'ok', body_id: 'body_a', operation: 'union' },
        body_store_snapshot: store('body_a'),
      },
    }
    const result = rows(checkpoints)
    result.ex3 = checkpoints.ex3.result

    resolveTouchWarnings(order, checkpoints, result)

    expect(result.ex3).not.toBe(checkpoints.ex3.result)
    expect(result.ex3).not.toHaveProperty('solver_warning')
    expect(checkpoints.ex3.result.solver_warning).toBe(touch('body_b'))
  })

  it('does nothing when feature ids repeat, because checkpoints are keyed by id', () => {
    const order = ['ex1', 'ex2', 'ex3', 'bo1', 'bo1']
    const checkpoints: Checkpoints = {
      ...base(),
      bo1: {
        result: { status: 'ok', body_id: 'body_a', operation: 'union' },
        body_store_snapshot: store('body_a'),
      },
    }
    const result = rows(checkpoints)

    resolveTouchWarnings(order, checkpoints, result)

    expect(result.ex3.solver_warning).toBe(touch('body_b'))
  })
})
