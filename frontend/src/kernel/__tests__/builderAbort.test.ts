// A build that stops between two features (`buildAbortable`) must leave a
// partial state the next build can take as prevState: only complete
// checkpoints, the first missing one dirty, and no owner left for a checkpoint
// the state no longer names. Pure: fake deps, no OCC.

import { describe, it, expect, vi } from 'vitest'
import { build, buildAbortable, buildSteps, findFirstDirty, type BuildAborted, type BuildResponse, type FeatureResult } from '../builder'
import { finalCheckpointOf } from '../builderMeshReuse'
import { makeDeps, makeTrackerDeps } from '../builderTestUtils'
import { barePart } from '../features/shared/partResolution'
import { markFeatureProgress, onFeatureStart } from '../featureProgress'
import type { OccHandle } from '../occ/handleTable'

const features = (n: number, tag = ''): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ id: `f${i}`, kind: 'sketch', tag }))

/** The result dict without its timings, which differ run to run. */
function results(r: BuildResponse): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r.result).map(([fid, res]) => {
    if (!res || typeof res !== 'object') return [fid, res]
    const { solve_ms: _ms, ...rest } = res as Record<string, unknown>
    void _ms
    return [fid, rest]
  }))
}

/** Abort at the yield after feature `index` finished. */
function abortAfter(index: number): () => boolean {
  let yields = 0
  return () => yields++ === index
}

const noYield = async (): Promise<void> => {}

function aborted(out: BuildResponse | BuildAborted): BuildAborted {
  expect('aborted' in out).toBe(true)
  return out as BuildAborted
}

describe('buildSteps', () => {
  it('driven to completion equals build()', () => {
    const spec = { features: features(5) }
    const viaBuild = build(spec, {}, makeTrackerDeps())
    const steps = buildSteps(spec, {}, makeTrackerDeps())
    const indices: number[] = []
    let step = steps.next()
    while (!step.done) {
      indices.push(step.value.featureIndex)
      step = steps.next()
    }
    const viaSteps = step.value
    expect(indices).toEqual([0, 1, 2, 3, 4])
    expect(results(viaSteps)).toEqual(results(viaBuild))
    expect(viaSteps.bodies).toEqual(viaBuild.bodies)
    expect(viaSteps._build_state.feature_order).toEqual(viaBuild._build_state.feature_order)
    expect(Object.keys(viaSteps._build_state.checkpoints)).toEqual(Object.keys(viaBuild._build_state.checkpoints))
  })

  it('yields after a suppressed feature too', () => {
    const spec = { features: [{ id: 'a', kind: 'sketch' }, { id: 'b', kind: 'sketch', suppressed: true }] }
    const steps = buildSteps(spec, {}, makeDeps())
    expect(steps.next().value).toMatchObject({ featureIndex: 0 })
    expect(steps.next().value).toMatchObject({ featureIndex: 1 })
    expect(steps.next().done).toBe(true)
  })
})

describe('buildAbortable', () => {
  it('runs to the same response when never asked to stop', async () => {
    const spec = { features: features(4) }
    const out = await buildAbortable(spec, {}, makeTrackerDeps(), () => false, noYield)
    expect('aborted' in out).toBe(false)
    expect(results(out as BuildResponse)).toEqual(results(build(spec, {}, makeTrackerDeps())))
  })

  it('keeps the finished checkpoints, and the next build resumes at the first missing one', async () => {
    const spec = { features: features(5) }
    const solved: string[] = []
    const deps = makeDeps({
      trySolveFeature: (feature): FeatureResult => {
        solved.push(String(feature.id))
        return { status: 'ok', solved: feature.id }
      },
    })
    const stop = aborted(await buildAbortable(spec, {}, deps, abortAfter(2), noYield))
    expect(stop.state.feature_order).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])
    expect(Object.keys(stop.state.checkpoints)).toEqual(['f0', 'f1', 'f2'])
    expect(stop.dropped).toEqual([])
    expect(solved).toEqual(['f0', 'f1', 'f2'])

    expect(findFirstDirty(spec.features, stop.state)).toBe(3)
    solved.length = 0
    const resumed = build(spec, { prevState: stop.state }, deps)
    expect(solved).toEqual(['f3', 'f4'])
    // The kept checkpoints are carried by identity, as any clean prefix is.
    expect(resumed._build_state.checkpoints.f2).toBe(stop.state.checkpoints.f2)
    expect(results(resumed)).toEqual(results(build(spec, {}, deps)))
  })

  it('runs the post-loop registration on a stop for a checkpoint whose bodies still need it', async () => {
    // f2 creates a shaped body whose loop-side registration does not land (the
    // fake extractor knows no body), so its checkpoint and every later one
    // still need the post-loop pass. The stop runs it instead of dropping them.
    const releaseCheckpoint = vi.fn()
    const extracted: string[][] = []
    const deps = makeDeps({
      trySolveFeature: (feature, _repo, partStore): FeatureResult => {
        if (feature.id === 'f2') partStore.b = { ...barePart('b', 'f2'), shape: 7 as OccHandle }
        return { status: 'ok' }
      },
      extractBrepMetadata: (store) => { extracted.push(Object.keys(store)); return {} },
      releaseCheckpoint,
    })
    const stop = aborted(await buildAbortable({ features: features(5) }, {}, deps, abortAfter(3), noYield))
    expect(Object.keys(stop.state.checkpoints)).toEqual(['f0', 'f1', 'f2', 'f3'])
    expect(stop.dropped).toEqual([])
    expect(releaseCheckpoint).not.toHaveBeenCalled()
    // The completed checkpoints carry the post-loop serializer's marker; the
    // ones that needed nothing keep the loop's snapshot.
    expect((stop.state.checkpoints.f2.repo_snapshot as { version?: number }).version).toBe(2)
    expect((stop.state.checkpoints.f1.repo_snapshot as { version?: number }).version).toBeUndefined()
    expect(extracted.filter((ids) => ids.includes('b')).length).toBeGreaterThan(0)
  })

  it('releases only the restore copies when every finished checkpoint is kept', async () => {
    const releaseCheckpoint = vi.fn()
    const releaseRestoreCopies = vi.fn()
    const deps = makeDeps({ releaseCheckpoint, releaseRestoreCopies })
    aborted(await buildAbortable({ features: features(5) }, {}, deps, abortAfter(2), noYield))
    expect(releaseRestoreCopies).toHaveBeenCalledTimes(1)
    expect(releaseCheckpoint).not.toHaveBeenCalled()
  })

  it('truncates at a feature id solved twice, so a release by owner cannot reach a kept checkpoint', async () => {
    const releaseCheckpoint = vi.fn()
    const spec = { features: [{ id: 'a', kind: 'sketch' }, { id: 'd', kind: 'sketch' }, { id: 'e', kind: 'sketch' }, { id: 'd', kind: 'sketch' }, { id: 'g', kind: 'sketch' }] }
    const stop = aborted(await buildAbortable(spec, {}, makeDeps({ releaseCheckpoint }), abortAfter(3), noYield))
    expect(Object.keys(stop.state.checkpoints)).toEqual(['a'])
    expect(stop.dropped.sort()).toEqual(['d', 'e'])
  })

  it('drops the carried final mesh marker once a solved checkpoint follows it', async () => {
    // The previous final checkpoint's meshes describe the bodies at that
    // feature; served as the next build's final meshes after a later kept
    // feature changed a body, they would be stale.
    const deps = makeTrackerDeps()
    const first = build({ features: features(2) }, {}, deps)
    expect(finalCheckpointOf(first._build_state)).toBe(first._build_state.checkpoints.f1)
    const stop = aborted(await buildAbortable({ features: features(4) }, { prevState: first._build_state }, deps, abortAfter(0), noYield))
    expect(Object.keys(stop.state.checkpoints)).toEqual(['f0', 'f1', 'f2'])
    expect(finalCheckpointOf(stop.state)).toBeNull()
    // Copied, never edited: the previous state still holds its own marker.
    expect(first._build_state.checkpoints.f1.mesh_stable_since).toBeDefined()
  })

  it('clears the feature progress mark on a stop', async () => {
    const marks: string[] = []
    const unsubscribe = onFeatureStart((fid) => marks.push(fid))
    try {
      aborted(await buildAbortable({ features: features(3) }, {}, makeDeps(), abortAfter(0), noYield))
      marks.length = 0
      markFeatureProgress()
      expect(marks).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it('yields once per finished feature', async () => {
    const yieldNow = vi.fn(async () => {})
    await buildAbortable({ features: features(3) }, {}, makeDeps(), () => false, yieldNow)
    expect(yieldNow).toHaveBeenCalledTimes(3)
  })
})
