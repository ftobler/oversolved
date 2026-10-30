// @vitest-environment node
//
// add_part_pattern in the headless session, with injected bundles and the echo
// mate solver (no OCC, no WASM): the expansion into instances and mates, the
// seeds landing on the holes, the one-undo-entry rule and the all-or-nothing
// refusals.

import { describe, it, expect, afterEach } from 'vitest'
import type { BodyResult, FaceData, PartDoc } from '@/types/cad'
import type { Anchor, PartBundle } from '@/kernel/partBundle'
import { BUNDLE_SCHEMA } from '@/kernel/partBundle'
import { makeEchoSolver } from '@/kernel/solveAssemblyTestUtils'
import { partInstances } from '@/utils/assemblyMutations'
import { rotateVector, transformQuat } from '@/utils/transform3d'
import { createHeadlessAssembly, emptyDriveAssemblyDoc, setMateSolver, type InjectedBundle } from '../headlessAssembly'
import type { AssemblyScriptStep } from '../headlessAssembly'

const HOLES = 7
const RADIUS = 20

function partDoc(id: string): PartDoc {
  return { version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] } as PartDoc
}

function ringPoint(i: number): [number, number, number] {
  const a = (2 * Math.PI * i) / HOLES
  return [RADIUS * Math.cos(a), 0, RADIUS * Math.sin(a)]
}

// One flat face per anchor, so a face selector matches them all.
function bundleOf(docId: string, points: Array<[number, number, number]>): InjectedBundle {
  const anchors: Record<string, Anchor> = {}
  const faceData: FaceData[] = points.map(point => ({ centroid: point, normal: [0, 1, 0], surface_type: 'flatface' }))
  points.forEach((point, i) => {
    anchors[`a${i}`] = { kind: 'plane', point, axis: [0, 1, 0], geom_hash: `@u|${docId}${i}`, created_by: 'ex1' }
  })
  const body: BodyResult = {
    id: 'body_ex1',
    created_by: 'ex1',
    modified_by: [],
    edges: [],
    mesh: {
      vertices: [],
      faces: [],
      face_data: faceData,
      face_queries: points.map((_, i) => `q_${docId}_${i}`),
      face_edge_queries: points.map(() => []),
    },
  }
  const bundle: PartBundle = {
    doc_id: docId,
    content_hash: 'h',
    schema: BUNDLE_SCHEMA,
    bodies: [{
      mesh: { vertices: new Float32Array(0), indices: new Uint32Array(0), faceIdsPerTriangle: new Uint32Array(0) },
      edges: [],
      entityAnchors: { faces: points.map((_, i) => [`a${i}`]), edges: [], vertices: [] },
    }],
    anchors,
  }
  return { bundle, bodies: { body_ex1: body } }
}

// The bundle memo is keyed by part content, so each wall variant gets its own
// content or a later session would reuse an earlier session's holes.
function session(wallPoints = Array.from({ length: HOLES }, (_, i) => ringPoint(i)), variant = 'ring') {
  return createHeadlessAssembly({
    doc: emptyDriveAssemblyDoc(),
    parts: new Map([['wall_part', partDoc(`wall_${variant}`)], ['nut_part', partDoc('nut_part')]]),
    bundleSource: async docId => (docId === 'wall_part' ? bundleOf(docId, wallPoints) : bundleOf(docId, [[0, 0, 0]])),
  })
}

const PATTERN: AssemblyScriptStep = {
  mutation: {
    type: 'add_part_pattern',
    handlePrefix: 'nut',
    part: 'nut_part',
    kind: 'fixed',
    ref_a: { part: 'wall', selector: { kind: 'face', where: { type: 'flatface' } } },
    ref_b: { selector: { kind: 'face', where: { type: 'flatface' } } },
    flip: true,
    capture: true,
  },
}

const WALL: AssemblyScriptStep = { mutation: { type: 'add_part', handle: 'wall', part: 'wall_part', fixed: true } }

afterEach(() => {
  setMateSolver(null)
})

describe('add_part_pattern', () => {
  it('adds one seeded instance and one mate per match', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    const outcome = await s.run([WALL, PATTERN])
    expect(outcome.ok).toBe(true)
    const step = outcome.steps[1]
    expect(step.createdIds).toHaveLength(2 * HOLES)
    expect(step.createdIds.slice(0, 2)).toEqual(['inst_nut0', 'nut0_mate'])

    const nuts = partInstances(s.getDoc()).filter(i => i.handle.startsWith('nut'))
    expect(nuts.map(n => n.handle)).toEqual(Array.from({ length: HOLES }, (_, i) => `nut${i}`))
    // Every hole is covered exactly once: each nut's anchor (its local origin)
    // lands on a distinct ring point.
    const landed = new Set(nuts.map(n => `${n.transform.tx.toFixed(6)},${n.transform.tz.toFixed(6)}`))
    const expected = new Set(Array.from({ length: HOLES }, (_, i) => `${ringPoint(i)[0].toFixed(6)},${ringPoint(i)[2].toFixed(6)}`))
    expect(landed).toEqual(expected)
    // flip: true makes the nut's axis point against the wall's.
    const axis = rotateVector(transformQuat(nuts[0].transform), [0, 1, 0])
    expect(axis[1]).toBeCloseTo(-1, 9)
    const mates = (s.getDoc().features ?? []).filter(f => f.kind === 'mate')
    expect(mates.map(m => m.id)).toEqual(nuts.map(n => `${n.handle}_mate`))
    expect(step.captured).toMatchObject({ flip: true })
  })

  it('records the whole expansion as one undo entry', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run([WALL])
    const before = s.getDoc()
    const depth = s.history.undoLength()
    await s.run([PATTERN])
    expect(s.history.undoLength()).toBe(depth + 1)
    expect(s.history.undoLabels().at(-1)).toBe('Add part pattern')
    await s.run([{ command: 'undo' }])
    expect(s.getDoc()).toEqual(before)
  })

  it('names the same handles whatever order the part reports its holes in', async () => {
    setMateSolver(makeEchoSolver())
    const points = Array.from({ length: HOLES }, (_, i) => ringPoint(i))
    const forward = session(points)
    const backward = session([...points].reverse(), 'reversed')
    await forward.run([WALL, PATTERN])
    await backward.run([WALL, PATTERN])
    const positions = (s: typeof forward) => partInstances(s.getDoc())
      .filter(i => i.handle.startsWith('nut'))
      .map(i => [i.handle, i.transform.tx.toFixed(6), i.transform.tz.toFixed(6)])
    expect(positions(backward)).toEqual(positions(forward))
  })

  it('makes one copy for a single match', async () => {
    setMateSolver(makeEchoSolver())
    const s = session([ringPoint(0)], 'single')
    const outcome = await s.run([WALL, PATTERN])
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[1].createdIds).toEqual(['inst_nut0', 'nut0_mate'])
  })

  it('refuses a selector that matches nothing and leaves the document alone', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run([WALL])
    const before = s.getDoc()
    const depth = s.history.undoLength()
    const outcome = await s.run([{
      mutation: {
        ...(PATTERN as { mutation: Record<string, unknown> }).mutation,
        ref_a: { part: 'wall', selector: { kind: 'face', where: { type: 'cylinder' } } },
      } as never,
    }])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error?.message).toMatch(/no|match/i)
    expect(s.getDoc()).toEqual(before)
    expect(s.history.undoLength()).toBe(depth)
  })

  it('refuses a taken handle prefix before touching anything', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run([WALL, { mutation: { type: 'add_part', handle: 'nut3', part: 'nut_part' } }])
    const before = s.getDoc()
    const outcome = await s.run([PATTERN])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error?.message).toContain('nut3')
    expect(s.getDoc()).toEqual(before)
  })

  it('refuses an unresolvable ref_b and leaves the document and history alone', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run([WALL])
    const before = s.getDoc()
    const depth = s.history.undoLength()
    const outcome = await s.run([{
      mutation: {
        ...(PATTERN as { mutation: Record<string, unknown> }).mutation,
        kind: 'fixed',
        ref_b: { anchor: 'missing' },
      } as never,
    }])
    expect(outcome.ok).toBe(false)
    expect(s.getDoc()).toEqual(before)
    expect(s.history.undoLength()).toBe(depth)
  })

  it('refuses ref_b carrying a part and ref_a using a query', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run([WALL])
    const base = (PATTERN as { mutation: Record<string, unknown> }).mutation
    const withPart = await s.run([{ mutation: { ...base, ref_b: { part: 'x', anchor: 'a0' } } as never }])
    expect(withPart.steps[0].error?.message).toContain('ref_b carries no part')
    const wrongType = await s.run([{ mutation: { ...base, ref_b: { anchor: 5 } } as never }])
    expect(wrongType.steps[0].error?.message).toContain('ref_b.anchor must be a non-empty string')
    const withQuery = await s.run([{ mutation: { ...base, ref_a: { part: 'wall', query: 'q_wall_part_0' } } as never }])
    expect(withQuery.steps[0].error?.message).toContain('selector')
  })
})
