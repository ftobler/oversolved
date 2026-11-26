// Releasing one reference of a mate must not turn an unpicked mate into a solve
// error. A half-empty mate is exactly the shape of a freshly added one: the
// solver marks it stale and contributes no constraint, so the parts it used to
// bind settle back to their seeds.

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import type { AssemblyDoc, Transform3D } from '../../types/cad'
import { solveAssembly } from '../solveAssembly'
import { bundleCachePut } from '../bundleCache'
import { mateSpecs } from '@/utils/assemblySolveInput'
import { planAssemblyOperation } from '@/utils/assemblyOperations'
import {
  makeRelay, makeAxialBundle, identityTransform, translationTransform, makeCaptureSolver, freshDb,
} from '../solveAssemblyTestUtils'

beforeEach(() => { freshDb() })

function instance(handle: string, docId: string, transform: Transform3D) {
  return { id: `inst_${handle}`, kind: 'part_instance' as const, instance: {
    handle, doc_id: docId, doc_rev: 0, transform, visible: true,
  } }
}

describe('a mate with one cleared reference', () => {
  it('solves with no error row and binds nothing', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeAxialBundle('doc-a', '1'))
    await bundleCachePut(makeAxialBundle('doc-b', '1'))

    const seedB = translationTransform(5, 0, 0)
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: seedB },
    ]
    const doc: AssemblyDoc = {
      kind: 'assembly',
      features: [
        instance('p1', 'doc-a', identityTransform()),
        instance('p2', 'doc-b', seedB),
        { id: 'm1', kind: 'mate', mate: {
          kind: 'fixed',
          ref_a: { part: 'p1', anchor: 'a1' },
          ref_b: { part: 'p2', anchor: 'a1' },
        } },
      ],
    }

    const boundCapture = makeCaptureSolver()
    const bound = await solveAssembly(
      parts, { 'doc-a': '1', 'doc-b': '1' }, mateSpecs(doc), relay, boundCapture.solver,
    )
    expect(bound.status.mates.m1.error).toBeUndefined()
    expect(boundCapture.captured.input!.mates).toHaveLength(1)

    // Clear the second reference through the operation the chip's Remove runs.
    const plan = planAssemblyOperation('clear_mate_ref', { id: 'm1', field: 'ref_b' }, {
      doc, transforms: {},
    })!
    const releasedCapture = makeCaptureSolver()
    const released = await solveAssembly(
      parts, { 'doc-a': '1', 'doc-b': '1' }, mateSpecs(plan.doc), relay, releasedCapture.solver,
    )
    expect(released.status.mates.m1.error).toBeUndefined()
    // The half-empty mate contributes no constraint at all: the solve is a
    // trivial echo with no solver round trip, so the pair it used to bind is
    // never handed to the solver and the part stays where its seed puts it.
    expect(releasedCapture.captured.input).toBeUndefined()
    expect(released.transforms.p2).toEqual(seedB)

    // Clearing the last reference leaves a mate with no picks. It must not hit
    // the solve's "a mate needs two different parts" guard: an unpicked mate
    // is the shape a fresh add_mate starts in, not an error.
    const bothCleared = planAssemblyOperation('clear_mate_ref', { id: 'm1', field: 'ref_a' }, {
      doc: plan.doc, transforms: {},
    })!
    const emptyCapture = makeCaptureSolver()
    const empty = await solveAssembly(
      parts, { 'doc-a': '1', 'doc-b': '1' }, mateSpecs(bothCleared.doc), relay, emptyCapture.solver,
    )
    expect(empty.status.mates.m1).toBeUndefined()
    expect(emptyCapture.captured.input).toBeUndefined()
  })
})
