import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { solveAssembly, assemblyAnchors, type MateSpec } from '../solveAssembly'
import { bundleCachePut } from '../bundleCache'
import { ASSEMBLY_HANDLE, ASSEMBLY_ORIGIN_ID, ASSEMBLY_TOP_ID } from '../../utils/assemblyBuiltins'
import { mateFailure, partFailure } from '../../utils/core/assemblyStatus'
import type { AnchorKind } from '../partBundle'
import {
  makeRelay, makeBundle, makeAxialBundle, translationTransform, identityTransform,
  makeCaptureSolver, makeEchoSolver, freshDb,
} from '../solveAssemblyTestUtils'

beforeEach(() => { freshDb() })

describe('solveAssembly', () => {
  // ─── assembly built-ins as ground (Stage 6c) ───

  it('resolves a fixed mate from a part to the assembly Top plane through assemblyAnchors', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeAxialBundle('doc-a', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: translationTransform(0, 5, 0) },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'fixed',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_TOP_ID },
      },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': '1' }, mates, relay, solver)

    // The mate resolved (not stale) and the part got a solved transform.
    expect(result.status.mates['m1'].stale).toBe(false)
    expect(result.transforms).toHaveProperty('p1')
    // The assembly frame is synthetic: it never appears as an output transform.
    expect(result.transforms).not.toHaveProperty(ASSEMBLY_HANDLE)

    // The solver saw the part body (0) + a pinned assembly frame body (1).
    expect(captured.input!.nBodies).toBe(2)
    expect(captured.input!.fixedMask[0] & 0b10).toBe(0b10)  // body 1 pinned

    // ref_b carried the Top-plane anchor geometry from assemblyAnchors.
    const rec = captured.input!.mates[0]
    expect(rec.bodyA).toBe(0)
    expect(rec.bodyB).toBe(1)
    const top = assemblyAnchors[ASSEMBLY_TOP_ID]
    expect(rec.pointB).toEqual(top.point)
    expect(rec.axisB).toEqual(top.axis)
  })

  it('flags a mate stale when the assembly anchor id is unknown', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'fixed',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: ASSEMBLY_HANDLE, anchor: 'NoSuchPlane' },
      },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1' }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_b')
  })

  it('flags a mate stale with an error, not fixed, for an unknown mate kind', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'bad', kind: 'not_a_real_kind', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
      { id: 'ok', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a2' }, ref_b: { part: 'p2', anchor: 'a2' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    expect(result.status.mates['bad'].stale).toBe(true)
    expect(result.status.mates['bad'].error).toContain('not_a_real_kind')
    expect(result.status.mates['ok'].stale).toBe(false)
    // The unknown mate contributes zero bytes to the encoded buffer -- not
    // coerced into a `fixed` (kindCode 0) record.
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('flags a mate stale with an error for an unknown anchor kind', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1', {
      // `as AnchorKind`: simulates a bundle built by a newer app version that
      // added a kind this build's union doesn't know about yet.
      anchors: {
        a1: { kind: 'not_a_real_anchor_kind' as AnchorKind, point: [0, 0, 0], axis: [0, 0, 1], geom_hash: 'g', created_by: 'f' },
        a2: { kind: 'point', point: [1, 0, 0], axis: [0, 0, 1], geom_hash: 'g2', created_by: 'f' },
      },
    }))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'bad', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
      { id: 'ok', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a2' }, ref_b: { part: 'p2', anchor: 'a2' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    expect(result.status.mates['bad'].stale).toBe(true)
    expect(result.status.mates['bad'].error).toContain('not_a_real_anchor_kind')
    expect(result.status.mates['ok'].stale).toBe(false)
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('refuses an unresolved expression-valued parameter instead of reading it as zero', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates: MateSpec[] = [
      {
        id: 'bad', kind: 'fixed',
        ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' },
        angle: 'w / 2',
      },
      { id: 'ok', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a2' }, ref_b: { part: 'p2', anchor: 'a2' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    expect(result.status.mates['bad'].stale).toBe(true)
    expect(result.status.mates['bad'].error).toContain('angle')
    expect(result.status.mates['ok'].stale).toBe(false)
    // The bad mate contributes zero bytes to the encoded buffer: it is not
    // coerced to angle 0 and encoded as a success.
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('refuses an axis-reading mate whose anchor has no meaningful axis, but keeps spherical legal', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    // makeBundle's a1/a2 are vertex anchors: their axis is the [0, 0, 1]
    // placeholder, not geometry.
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates: MateSpec[] = [
      { id: 'rotating', kind: 'rotating', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
      { id: 'spherical', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a2' }, ref_b: { part: 'p2', anchor: 'a2' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    expect(result.status.mates['rotating'].stale).toBe(true)
    expect(result.status.mates['rotating'].error).toContain('axis')
    // The placeholder-axis mate is not encoded; spherical, which never reads an
    // axis, still solves.
    expect(captured.input!.mates).toHaveLength(1)
    expect(result.status.mates['spherical'].stale).toBe(false)
  })

  it('keeps an axis-reading mate with an inline anchor legal (the drag objective authors its own axis)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
    ]
    // The triad drag objective: a fixed mate whose anchors are synthetic points
    // carrying an authored axis. A point kind here is not a B-rep placeholder.
    const mates: MateSpec[] = [{
      id: 'drag',
      kind: 'fixed',
      ref_a: { part: ASSEMBLY_HANDLE, anchor: 'drag', inlineAnchor: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '', created_by: 'drag' } },
      ref_b: { part: 'p1', anchor: 'drag', inlineAnchor: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '', created_by: 'drag' } },
    }]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': '1' }, mates, relay, solver)

    expect(result.status.mates['drag'].stale).toBe(false)
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('trusts the assembly frame origin axis even though its kind is a point', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeAxialBundle('doc-a', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
    ]
    // The assembly origin is a point anchor with a deliberately canonical +Z,
    // so a revolute joint to it is legal even though a PART vertex point is not.
    const mates: MateSpec[] = [{
      id: 'm1', kind: 'rotating',
      ref_a: { part: 'p1', anchor: 'a1' },
      ref_b: { part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_ORIGIN_ID },
    }]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': '1' }, mates, relay, solver)

    expect(result.status.mates['m1'].stale).toBe(false)
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('flags a mate stale with the two-parts message when both refs name the same part, and other mates still solve', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'self', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p1', anchor: 'a2' } },
      { id: 'ok', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    expect(result.status.mates['self'].stale).toBe(true)
    expect(result.status.mates['self'].error).toBe('a mate needs two different parts')
    expect(result.status.mates['ok'].stale).toBe(false)
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('reports a failed solve and falls back to seed transforms when the solve output has the wrong param count', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    // A solver that returns an output for only one body when two were sent.
    const shortSolver = (): Uint8Array => {
      const w = new DataView(new ArrayBuffer(20 + 7 * 4 + 24))
      w.setUint32(0, 0x3252_544D, true)  // MATE_MAGIC_OUT
      w.setUint32(4, 7, true)  // nParams = 7, but the caller expects 14
      w.setUint8(8, 0)
      return new Uint8Array(w.buffer)
    }
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, shortSolver)

    expect(result.status.verdict).toBe('failed')
    expect(result.status.error).toContain('params')
    expect(result.status.mates['m1'].error).toContain('params')
    expect(result.transforms['p2']).toEqual(translationTransform(5, 0, 0))
  })

  it('isolates a part whose bundle cannot be built and keeps the healthy parts solved', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-good', { kind: 'part', features: [] })
    // doc-bad is deliberately absent: requestPartDoc rejects with "not found".
    await bundleCachePut(makeBundle('doc-good', '1'))

    const parts = [
      { handle: 'hGood', doc_id: 'doc-good', transform: identityTransform() },
      { handle: 'hBad', doc_id: 'doc-bad', transform: translationTransform(9, 0, 0) },
    ]

    const result = await solveAssembly(parts, { 'doc-good': '1', 'doc-bad': '1' }, [], relay, makeEchoSolver())

    expect(result.status.parts['hBad']).toEqual({ failed: true, error: expect.stringContaining('not found') })
    expect(result.status.parts['hGood']?.failed).toBeFalsy()
    expect(result.transforms['hGood']).toEqual(identityTransform())
    // A failed part keeps its seed placement so the document does not lose it.
    expect(result.transforms['hBad']).toEqual(translationTransform(9, 0, 0))
    expect(result.bodies['hGood']).toHaveLength(1)
    expect(result.bodies['hBad']).toEqual([])
    expect(partFailure('hBad', result.status).failed).toBe(true)
    expect(partFailure('hGood', result.status).failed).toBe(false)
  })

  it('names an unsupported mate kind through the status carrier', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'worm_gear', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]

    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1']).toEqual({ stale: true, error: "unsupported mate kind 'worm_gear'" })
    expect(mateFailure('m1', result.status)).toMatchObject({
      failed: true, level: 'error', message: "unsupported mate kind 'worm_gear'",
    })
  })

  it('marks a mate whose solver trapped even without a stale flag, and sets stale too', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const trapping = () => { throw new Error('bad mate output magic') }

    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, trapping)

    expect(result.status.mates['m1'].error).toContain('bad mate output magic')
    expect(result.status.mates['m1'].stale).toBe(true)
    expect(mateFailure('m1', result.status)).toMatchObject({
      failed: true, level: 'error', message: 'bad mate output magic',
    })
  })

  it('carries an overconstrained verdict with its residual in the status', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    // The echo solver with status code 2 (overconstrained) and a nonzero
    // residual: the real-WASM counterpart lives in solveAssemblyReal.test.ts.
    const overSolver = (input: Uint8Array): Uint8Array => {
      const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
      const nBodies = view.getUint32(4, true)
      const nParams = nBodies * 7
      const paramsOffset = 20 + nBodies * 4
      const outSize = 4 + 4 + 1 + nParams * 4 + 4 + 28  // +4 for the n_mates header
      const out = new DataView(new ArrayBuffer(outSize))
      let pos = 0
      out.setUint32(pos, 0x3252544D, true); pos += 4
      out.setUint32(pos, nParams, true); pos += 4
      out.setUint8(pos, 2); pos += 1
      for (let i = 0; i < nParams; i++) { out.setFloat32(pos, view.getFloat32(paramsOffset + i * 4, true), true); pos += 4 }
      out.setUint32(pos, 0, true); pos += 4  // n_mates
      out.setFloat64(pos, 0.5, true); pos += 8
      out.setUint32(pos, 13, true); pos += 4
      out.setUint32(pos, 0, true); pos += 4
      out.setUint32(pos, 1, true); pos += 4
      out.setFloat64(pos, 0.001, true); pos += 8
      return new Uint8Array(out.buffer)
    }

    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, overSolver)

    expect(result.status.verdict).toBe('overconstrained')
    expect(result.status.residualNorm).toBeGreaterThan(0)
  })

  // ─── fixed instances (Stage 6d) ───

  it('pins a fixed part instance in the LM state and leaves free parts unpinned', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform(), fixed: true },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    expect(captured.input!.nBodies).toBe(2)
    expect(captured.input!.fixedMask[0] & 0b01).toBe(0b01)  // body 0 pinned
    expect(captured.input!.fixedMask[0] & 0b10).toBe(0)     // body 1 free
  })

  it('pins the fixed part alongside the assembly frame when a mate uses both', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeAxialBundle('doc-a', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform(), fixed: true },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'fixed',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_TOP_ID },
      },
    ]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': '1' }, mates, relay, solver)

    expect(captured.input!.nBodies).toBe(2)
    expect(captured.input!.fixedMask[0] & 0b11).toBe(0b11)  // part + frame both pinned
  })

  it('does not allocate an assembly frame body when no mate references it', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    // Only the two part bodies; nothing pinned.
    expect(captured.input!.nBodies).toBe(2)
    expect(captured.input!.fixedMask[0]).toBe(0)
  })
})
