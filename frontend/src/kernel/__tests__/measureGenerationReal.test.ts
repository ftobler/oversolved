// @vitest-environment node
//
// The live-cache measurement, against the real kernel: a request names the solve
// generation it was asked against and the body set its picks were made in, and
// the engine answers from the geometry it still holds or refuses by name.
//
// The pick set is the case that would silently read the wrong geometry: while a
// feature edit is open, the viewport renders the pick-boundary checkpoint, so a
// measurement of a body the edited feature has not moved yet must read the OLD
// distance. The same pick refs against the final set read the new one.
//
// Skips when OCC.js or the Rust sketch solver is absent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { resetSketchSolver, setSketchSolver, setSketchTopology } from '../features/sketch'
import { currentGeneration, measureGeneration, measurePicksLocally, setSolveLocalsForTest, solveLocally } from '../solveLocally'
import { MEASURE_STALE, MEASURE_UNRESOLVED, type MeasurePickRef } from '../worker/solverProtocol'
import type { PartResult, EdgeData, FaceData } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  plane = '@builtin_plane_front',
): Record<string, unknown> {
  return {
    id, kind: 'sketch', plane,
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [x, y, x + w, y], right: [x + w, y, x + w, y + h],
      top: [x + w, y + h, x, y + h], left: [x, y + h, x, y],
    },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: h },
    ],
  }
}

const extrude = (sketch: string, id: string, distance: number): Record<string, unknown> =>
  ({ id, kind: 'extrude', extrude: { sketch: `$${sketch}`, distance, direction: 'normal', operation: 'new' } })

const PART = (id: string): MeasurePickRef => ({ bodyId: id, kind: 'body' })

async function solve(
  doc: Record<string, unknown>,
  options: { pickBoundary?: number; rollbackPosition?: number } = {},
): Promise<{ bodies: Record<string, PartResult>; generation: string }> {
  const response = await solveLocally(doc, options)
  if (!response) throw new Error('no build response')
  const failed = Object.entries(response.result)
    .filter(([, r]) => (r as { status?: string }).status === 'exception')
  if (failed.length) throw new Error(`feature exception: ${JSON.stringify(failed)}`)
  return { bodies: response.bodies as Record<string, PartResult>, generation: response.generation ?? '' }
}

const faceIndex = (part: PartResult, match: (face: FaceData) => boolean): number => {
  const index = (part.mesh?.face_data ?? []).findIndex(match)
  if (index < 0) throw new Error(`no matching face: ${JSON.stringify(part.mesh?.face_data)}`)
  return index
}

const edgeIndex = (part: PartResult, match: (edge: EdgeData) => boolean): number => {
  const index = (part.edges ?? []).findIndex(match)
  if (index < 0) throw new Error(`no matching edge: ${JSON.stringify(part.edges)}`)
  return index
}

/** The flat face on the given world x, read off the render array. */
const faceAtX = (part: PartResult, x: number): number =>
  faceIndex(part, (face) => face.surface_type === 'flatface' &&
    Math.abs(face.normal[0]) > 0.99 && Math.abs(face.centroid[0] - x) < 1e-6)

describe.skipIf(!oc || !solveBytes)('measureGeneration (real OCC)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSketchTopology(loadTopology())
    setSolveLocalsForTest(async () => oc)
  }, 180_000)

  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('refuses a request for a generation the cache no longer holds', async () => {
    const separate = {
      id: 'measure-gen-a',
      features: [
        rectSketch('sk1', 0, 0, 10, 10), extrude('sk1', 'ex1', 10),
        rectSketch('sk2', 30, 0, 10, 10), extrude('sk2', 'ex2', 10),
      ],
    }
    const first = await solve(separate)
    expect(first.generation).toMatch(/^[0-9a-z]+:[0-9]+$/)
    const picks: MeasurePickRef[] = [PART('body_ex1'), PART('body_ex2')]

    const fresh = await measureGeneration({
      generation: first.generation, set: 'final', op: 'clearance', picks,
    })
    expect(fresh).toEqual({ ok: true, value: 20, points: expect.any(Array) })

    // A stale token is refused before any handle is read.
    const stale = await measureGeneration({
      generation: 'boot:0', set: 'final', op: 'clearance', picks,
    })
    expect(stale).toEqual({ ok: false, error: MEASURE_STALE })

    // Every solve moves the token, and so does a document switch.
    const second = await solve(separate)
    expect(second.generation).not.toBe(first.generation)
    const afterSolve = await measureGeneration({
      generation: first.generation, set: 'final', op: 'clearance', picks,
    })
    expect(afterSolve).toEqual({ ok: false, error: MEASURE_STALE })
    expect(currentGeneration()).toBe(second.generation)

    const other = await solve({
      id: 'measure-gen-b',
      features: [rectSketch('sk1', 0, 0, 10, 10), extrude('sk1', 'ex1', 10)],
    })
    expect(other.generation).not.toBe(second.generation)
  }, 300_000)

  it('measures the pick-boundary checkpoint for the pick set', async () => {
    // Two boxes 30 apart, then a transform that slides the first one 10 along x
    // while the edit is open. The pick set is the state before that transform.
    const doc = {
      id: 'measure-gen-pick',
      features: [
        rectSketch('sk1', 0, 0, 10, 10), extrude('sk1', 'ex1', 10),
        rectSketch('sk2', 30, 0, 10, 10), extrude('sk2', 'ex2', 10),
        { id: 'tr1', kind: 'transform', transform: { bodies: ['@body_ex1'], operation: 'replace', translation: [10, 0, 0] } },
      ],
    }
    const { bodies, generation } = await solve(doc, { pickBoundary: 4, rollbackPosition: 5 })
    const picks: MeasurePickRef[] = [PART('body_ex1'), PART('body_ex2')]

    const final = await measureGeneration({ generation, set: 'final', op: 'clearance', picks })
    expect(final.ok).toBe(true)
    if (!final.ok) throw new Error('unreachable')
    expect(final.value).toBeCloseTo(10, 6)

    // The pick checkpoint is the state after ex2 and before the transform: the
    // first box still starts at x = 0, so the gap is 20.
    const pick = await measureGeneration({ generation, set: 'pick', op: 'clearance', picks })
    expect(pick.ok).toBe(true)
    if (!pick.ok) throw new Error('unreachable')
    expect(pick.value).toBeCloseTo(20, 6)

    // The whole body in the pick set has the old geometry, and a body the pick
    // checkpoint does not hold is unresolved rather than measured from the final
    // set.
    expect(bodies.body_ex1).toBeDefined()
    const missing = await measureGeneration({
      generation, set: 'pick', op: 'clearance', picks: [PART('body_nope'), PART('body_ex2')],
    })
    expect(missing).toEqual({ ok: false, error: MEASURE_UNRESOLVED })
  }, 300_000)

  it('reads a clearance as gap, overlapping, or touching', async () => {
    const doc = {
      id: 'measure-gen-clearance',
      features: [
        // A: 10 x 10 x 10 at the origin.
        rectSketch('skA', 0, 0, 10, 10), extrude('skA', 'exA', 10),
        // B: 10 x 10 x 10, 20 to the right of A.
        rectSketch('skB', 30, 0, 10, 10), extrude('skB', 'exB', 10),
        // C: 10 x 10 x 10, one face shared with A at x = 10.
        rectSketch('skC', 10, 0, 10, 10), extrude('skC', 'exC', 10),
        // D: 4 x 4 x 4 floating strictly inside A, from a plane offset off the
        // front so it shares no boundary with it.
        { id: 'pl1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 3 } },
        rectSketch('skD', 3, 3, 4, 4, '@pl1'), extrude('skD', 'exD', 4),
      ],
    }
    const { generation } = await solve(doc)
    const ids = { a: 'body_exA', b: 'body_exB', c: 'body_exC', d: 'body_exD' }

    const gap = await measureGeneration({
      generation, set: 'final', op: 'clearance', picks: [PART(ids.a), PART(ids.b)],
    })
    expect(gap.ok).toBe(true)
    if (!gap.ok) throw new Error('unreachable')
    expect(gap.value).toBeCloseTo(20, 6)
    expect(gap.note).toBeUndefined()

    const touching = await measureGeneration({
      generation, set: 'final', op: 'clearance', picks: [PART(ids.a), PART(ids.c)],
    })
    expect(touching.ok).toBe(true)
    if (!touching.ok) throw new Error('unreachable')
    expect(touching.value).toBe(0)
    expect(touching.note).toBe('touching')

    // A body wholly inside another has no overlapping boundary, so the distance
    // read alone would report a positive gap; the overlap probe is what makes
    // this 0.
    const inside = await measureGeneration({
      generation, set: 'final', op: 'clearance', picks: [PART(ids.a), PART(ids.d)],
    })
    expect(inside.ok).toBe(true)
    if (!inside.ok) throw new Error('unreachable')
    expect(inside.value).toBe(0)
    expect(inside.note).toBe('overlapping')
  }, 300_000)

  it('reads a face-to-face distance and refuses an element index out of range', async () => {
    const doc = {
      id: 'measure-gen-distance',
      features: [
        rectSketch('sk1', 0, 0, 10, 10), extrude('sk1', 'ex1', 10),
        rectSketch('sk2', 30, 0, 10, 10), extrude('sk2', 'ex2', 10),
      ],
    }
    const { bodies, generation } = await solve(doc)
    const a = bodies.body_ex1
    const b = bodies.body_ex2
    const picks: MeasurePickRef[] = [
      { bodyId: 'body_ex1', kind: 'face', index: faceAtX(a, 10) },
      { bodyId: 'body_ex2', kind: 'face', index: faceAtX(b, 30) },
    ]
    const read = await measureGeneration({ generation, set: 'final', op: 'distance', picks })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.value).toBeCloseTo(20, 6)
    expect(read.points).toHaveLength(2)

    const outOfRange = await measureGeneration({
      generation,
      set: 'final',
      op: 'distance',
      picks: [picks[0], { bodyId: 'body_ex2', kind: 'face', index: 999 }],
    })
    expect(outOfRange).toEqual({ ok: false, error: MEASURE_UNRESOLVED })

    // A clique of one pick for a pair op is a malformed request, not a crash.
    const one = await measureGeneration({ generation, set: 'final', op: 'distance', picks: [picks[0]] })
    expect(one).toEqual({ ok: false, error: MEASURE_UNRESOLVED })
  }, 300_000)

  it('reads a spline edge length from its render index', async () => {
    // The Ex010 profile: three lines and one interpolating spline, extruded. The
    // edge cannot be answered analytically, so this is the readout the kernel
    // exists for.
    const fit = [3, 1, 2.75, 1.5, 2.5, 1.75, 2, 1.5, 1.5, 1, 1, 1.25, 0.5, 1, 0, 1]
    const doc = {
      id: 'measure-gen-spline',
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [
            { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
            { id: 'sp', kind: 'fit_spline' }, { id: 'left', kind: 'line' },
          ],
          initial: { bottom: [0, 0, 3, 0], right: [3, 0, 3, 1], sp: fit, left: [0, 1, 0, 0] },
          constraints: ['bottom', 'right', 'sp', 'left'].map((id) => ({ id: `f${id}`, kind: 'fixed', target: { entity: id } })),
        },
        extrude('sk1', 'ex1', 1),
      ],
    }
    const { bodies, generation } = await solve(doc)
    const id = Object.keys(bodies)[0]
    const part = bodies[id]
    const index = edgeIndex(part, (edge) => edge.kind === 'spline')

    const read = await measureGeneration({
      generation, set: 'final', op: 'length', picks: [{ bodyId: id, kind: 'edge', index }],
    })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    // The render polyline is the curve sampled; the exact integral is within 1%
    // of it and strictly longer than the chord.
    const points = (part.edges![index] as { points: [number, number, number][] }).points
    let sampled = 0
    for (let i = 1; i < points.length; i++) {
      sampled += Math.hypot(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1],
        points[i][2] - points[i - 1][2],
      )
    }
    expect(read.value).toBeGreaterThan(sampled * 0.99)
    expect(read.value).toBeLessThan(sampled * 1.01)
  }, 300_000)

  it('answers the same pick headlessly, the MCP path', async () => {
    // `measure between` builds its own document and answers through the same
    // core and the store-level reader, so the two paths must agree on the kind
    // as well as the number.
    const fit = [3, 1, 2.75, 1.5, 2.5, 1.75, 2, 1.5, 1.5, 1, 1, 1.25, 0.5, 1, 0, 1]
    const doc = {
      id: 'measure-gen-headless',
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [
            { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
            { id: 'sp', kind: 'fit_spline' }, { id: 'left', kind: 'line' },
          ],
          initial: { bottom: [0, 0, 3, 0], right: [3, 0, 3, 1], sp: fit, left: [0, 1, 0, 0] },
          constraints: ['bottom', 'right', 'sp', 'left'].map((id) => ({ id: `f${id}`, kind: 'fixed', target: { entity: id } })),
        },
        extrude('sk1', 'ex1', 1),
      ],
    }
    const solved = await solve(doc)
    const id = Object.keys(solved.bodies)[0]
    const index = edgeIndex(solved.bodies[id], (edge) => edge.kind === 'spline')

    const read = await measurePicksLocally(doc, [`@${id}/edge/${index}`])
    expect(read).not.toBeNull()
    expect(read!.kind).toBe('length')
    expect(read!.value).toBeGreaterThan(1)

    // A pair of whole bodies is a clearance through the same entry.
    const pair = {
      id: 'measure-gen-headless-pair',
      features: [
        rectSketch('skA', 0, 0, 10, 10), extrude('skA', 'exA', 10),
        rectSketch('skB', 30, 0, 10, 10), extrude('skB', 'exB', 10),
      ],
    }
    const gap = await measurePicksLocally(pair, ['@body_exA', '@body_exB'])
    expect(gap).not.toBeNull()
    expect(gap!.kind).toBe('clearance')
    expect(gap!.value).toBeCloseTo(20, 6)
  }, 300_000)
})
