// @vitest-environment node
//
// A part's own frame as mate refs: the bare Origin/Top/Front/Right names the
// drive resolves, and what the mate solver does with them. The frame is minted
// as planes, so an axis-reading fixed mate accepts Origin; a vertex point
// anchor is still refused. The bundles are injected (no OCC), so these cases
// pin the drive and the solver boundary, not tessellation.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { partFrameAnchorId, toPartBundle, type PartBundle } from '@/kernel/partBundle'
import { findMate } from '@/utils/assemblyMutations'
import { makeEchoSolver } from '@/kernel/solveAssemblyTestUtils'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { AssemblyWireMutation, DriveMateOffset } from '../assemblyMutationCatalog'
import {
  createHeadlessAssembly,
  emptyDriveAssemblyDoc,
  setMateSolver,
  type AssemblyScriptStep,
  type InjectedBundle,
} from '../headlessAssembly'
import { mateFrames } from '../assemblyOutcome'

const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeSolve = solveMate ? describe : describe.skip

function partDoc(id: string): PartDoc {
  return { version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] } as PartDoc
}

/** A bundle with the part frame and no geometry: the smallest resolved part. */
function frameBundle(docId: string): PartBundle {
  return toPartBundle(docId, 'h', {})
}

function sessionWith(ids: string[], bundleFor: (docId: string) => PartBundle = frameBundle) {
  return createHeadlessAssembly({
    doc: emptyDriveAssemblyDoc(),
    parts: new Map(ids.map(id => [id, partDoc(id)])),
    bundleSource: async (docId): Promise<InjectedBundle> => ({ bundle: bundleFor(docId), bodies: {} }),
  })
}

function addPart(
  handle: string,
  part: string,
  opts: { fixed?: boolean; position?: [number, number, number] } = {},
): AssemblyScriptStep {
  const mutation: AssemblyWireMutation = {
    type: 'add_part', handle, part,
    ...(opts.fixed !== undefined && { fixed: opts.fixed }),
    ...(opts.position !== undefined && { position: opts.position }),
  }
  return { mutation }
}

/** A mate between the two part-frame anchors of the `a` and `b` instances. */
function frameMate(
  featureId: string,
  anchorA: string,
  anchorB: string,
  offset?: DriveMateOffset,
): AssemblyScriptStep {
  const mutation: AssemblyWireMutation = {
    type: 'add_mate', featureId, kind: 'fixed',
    ref_a: { part: 'a', anchor: anchorA },
    ref_b: { part: 'b', anchor: anchorB },
    ...(offset !== undefined && { offset }),
  }
  return { mutation }
}

afterEach(() => {
  setMateSolver(null)
})

describe('part-frame mate refs', () => {
  it('resolves Origin from the drive and names the stored anchor in the reply', async () => {
    setMateSolver(makeEchoSolver())
    const session = sessionWith(['div_a', 'div_b'])
    const outcome = await session.run([
      addPart('a', 'div_a', { fixed: true }),
      addPart('b', 'div_b', { position: [30, 0, 0] }),
      frameMate('m1', 'Origin', 'Origin', { x: 28 }),
    ])
    expect(outcome.ok).toBe(true)

    const originId = partFrameAnchorId('Origin')!
    expect(findMate(session.getDoc(), 'm1')!.ref_a).toMatchObject({
      anchor: originId,
      anchor_descriptor: { geom_hash: 'part-frame/origin', kind: 'plane', created_by: '', point: [0, 0, 0] },
    })

    // 3.3: the reply's frame names the stored anchor id beside its pose.
    const frames = mateFrames(session.getDoc(), session.lastSolve()!)
    expect(frames.m1.ref_a!.anchor).toBe(originId)
    expect(frames.m1.ref_b!.anchor).toBe(originId)
  })

  it('still refuses a vertex point anchor on a fixed mate', async () => {
    setMateSolver(makeEchoSolver())
    const vertexId = 'a_vertex'
    const session = sessionWith(['vert_a', 'vert_b'], (docId) => {
      const bundle = frameBundle(docId)
      bundle.anchors[vertexId] = {
        kind: 'point', point: [5, 0, 0], axis: [0, 0, 1], geom_hash: '@u|v', created_by: '',
      }
      return bundle
    })
    const outcome = await session.run([
      addPart('a', 'vert_a', { fixed: true }),
      addPart('b', 'vert_b'),
      // The driven path still stores the ref; the solve is the guard.
      {
        mutation: {
          type: 'add_mate', featureId: 'm1', kind: 'fixed',
          ref_a: { part: 'a', anchor: 'Origin' },
          ref_b: { part: 'b', anchor: vertexId },
        },
      },
    ])
    // A refused mate is data, not a failed call.
    expect(outcome.ok).toBe(true)
    expect(session.lastSolve()!.status.mates.m1).toMatchObject({
      stale: true,
      error: 'a fixed mate needs an anchor with an axis',
    })
  })
})

describeSolve('the frame anchors solve with the real mate solver', () => {
  beforeEach(() => {
    if (solveMate) setMateSolver(solveMate)
  })

  it('mates two Top frames 5 apart along +Y in A\'s own frame', async () => {
    const session = sessionWith(['top_a', 'top_b'])
    const outcome = await session.run([
      addPart('a', 'top_a', { fixed: true }),
      addPart('b', 'top_b', { position: [30, -20, 0] }),
      frameMate('m1', 'Top', 'Top', 5),
    ])
    expect(outcome.ok).toBe(true)

    const solve = session.lastSolve()!
    expect(solve.status.mates.m1).toMatchObject({ stale: false })
    expect(solve.status.verdict).toBe('fully_constrained')
    // B's Origin lands 5 along A's Top normal (+Y): the whole placement is the
    // frame, no face centroid arithmetic.
    const b = solve.transforms.b
    expect(b.tx).toBeCloseTo(0, 6)
    expect(b.ty).toBeCloseTo(5, 6)
    expect(b.tz).toBeCloseTo(0, 6)
  }, 60_000)
})
