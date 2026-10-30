// @vitest-environment node
//
// Capturing a mate's flip/angle from the instances' seeds: the pure table and
// patch rules (drive/assemblyCapture.ts), the drive's freeze into the document
// with the step report that names it, and -- with the real Rust mate solver but
// no OCC -- that the captured orientation is exactly what the solve holds. The
// editor's pick-time capture is pinned in utils/__tests__/mateCapture.test.ts;
// this file is its headless twin.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { AssemblyDoc, PartDoc, Transform3D } from '@/types/cad'
import type { Anchor } from '@/kernel/partBundle'
import { BUNDLE_SCHEMA, type PartBundle } from '@/kernel/partBundle'
import { quatFromEulerXyz, rotateVector } from '@/utils/transform3d'
import { findMate, partInstances } from '@/utils/assemblyMutations'
import { makeEchoSolver, makeTranslateSolver } from '@/kernel/solveAssemblyTestUtils'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import {
  createHeadlessAssembly,
  emptyDriveAssemblyDoc,
  setMateSolver,
  type AssemblyScriptStep,
  type InjectedBundle,
} from '../headlessAssembly'
import { captureMateAtSeeds, seedAnchorTable } from '../assemblyCapture'

// The mate solver is a separate wasm-pack package from OCC, so the "does the
// solve hold the captured pose" cases run without the kernel and skip only on
// a checkout with no wasm build at all.
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeSolve = solveMate ? describe : describe.skip

const IDENTITY: Transform3D = { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

/** An authored seed: a translation plus the editor's extrinsic XYZ degrees. */
function seedAt(position: [number, number, number], eulerDeg: [number, number, number] = [0, 0, 0]): Transform3D {
  const [rx, ry, rz] = eulerDeg.map(deg => (deg * Math.PI) / 180) as [number, number, number]
  const [qx, qy, qz, qw] = quatFromEulerXyz([rx, ry, rz])
  return { tx: position[0], ty: position[1], tz: position[2], qx, qy, qz, qw }
}

function plane(axis: [number, number, number], geomHash: string, point: [number, number, number] = [0, 0, 0]): Anchor {
  return { kind: 'plane', point, axis, geom_hash: geomHash, created_by: 'ex1' }
}

function circle(axis: [number, number, number], geomHash: string): Anchor {
  return { kind: 'circle', point: [0, 0, 0], axis, geom_hash: geomHash, created_by: 'ex1' }
}

function heelAnchor(): Anchor {
  return { kind: 'point', point: [0, 0, -20], axis: [0, 0, 1], geom_hash: '@gdf|heel', created_by: 'ex1' }
}

/** An assembly seeded with one part instance per entry, no mates yet. */
function seeded(entries: Record<string, Transform3D>): AssemblyDoc {
  const doc = emptyDriveAssemblyDoc()
  const features = [...(doc.features ?? [])]
  for (const [handle, transform] of Object.entries(entries)) {
    features.push({
      id: `inst_${handle}`,
      kind: 'part_instance',
      instance: { handle, doc_id: `doc_${handle}`, doc_rev: 0, transform },
    })
  }
  return { ...doc, features }
}

function table(doc: AssemblyDoc, anchors: Record<string, Record<string, Anchor>>) {
  return seedAnchorTable(doc, handle => anchors[handle])
}

const BOX_ANCHORS: Record<string, Record<string, Anchor>> = {
  box_a: { face: plane([0, 0, 1], '@gdf|a') },
  // The second box offers the same face in its own frame plus the underside
  // opposite to it: a seed that turns it over is what makes the two faces
  // meet, and the underside is what meets them parallel instead.
  box_b: { face: plane([0, 0, 1], '@gdf|b'), under: plane([0, 0, -1], '@gdf|b2') },
}

// The run-1 handle: its mount face normal is local +Y and its two legs run
// along local -Z, so standing it on the plate with the legs along world -Y is
// a quarter turn about X. Before capture existed this mate took three
// hand-authored angles (0, 90, 270) to find that roll.
const HANDLE_ANCHORS: Record<string, Record<string, Anchor>> = {
  plate: { top: plane([0, 0, 1], '@gdf|top') },
  handle: { mount: plane([0, 1, 0], '@gdf|mount'), heel: heelAnchor() },
}

// Two circle edges whose own axes point opposite ways: an extruded hole's
// circle and a revolved seat's circle read different orientations for the same
// physical contact, so flip cannot be reasoned from the kinds alone.
const CIRCLE_ANCHORS: Record<string, Record<string, Anchor>> = {
  flange: { hole: circle([0, 0, 1], '@gdf|hole') },
  seat: { seat: circle([0, 0, -1], '@gdf|seat') },
}

// ─── pure: the seed table and the patch it implies ───

describe('captureMateAtSeeds', () => {
  it('captures flip for two boxes seeded face-to-face and none side by side', () => {
    const faceToFace = captureMateAtSeeds({
      kind: 'fixed',
      ref_a: { part: 'box_a', anchor: 'face' },
      ref_b: { part: 'box_b', anchor: 'face' },
      anchors: table(seeded({ box_a: IDENTITY, box_b: seedAt([0, 0, 0], [180, 0, 0]) }), BOX_ANCHORS),
    })
    expect(faceToFace).not.toBeNull()
    expect(faceToFace!.captured).toEqual({ flip: true, angle: 180 })
    expect(faceToFace!.patch).toEqual({ flip: true, angle: 180 })

    const sideBySide = captureMateAtSeeds({
      kind: 'fixed',
      ref_a: { part: 'box_a', anchor: 'face' },
      ref_b: { part: 'box_b', anchor: 'face' },
      anchors: table(seeded({ box_a: IDENTITY, box_b: seedAt([100, 0, 0]) }), BOX_ANCHORS),
    })
    // Both axes point +Z and the canonical frames already agree: nothing to
    // author, so the patch is empty and the YAML stays clean.
    expect(sideBySide!.captured).toEqual({ flip: false, angle: 0 })
    expect(sideBySide!.patch).toEqual({})
  })

  it('captures the handle roll that puts its legs along world -Y', () => {
    const doc = seeded({ plate: IDENTITY, handle: seedAt([0, 0, 0], [-90, 0, 0]) })
    const anchors = table(doc, HANDLE_ANCHORS)
    // The claim the fixture rests on: the heel runs along world -Y.
    const heel = anchors.handle.heel.point
    expect(heel[0]).toBeCloseTo(0, 9)
    expect(heel[1]).toBeCloseTo(-20, 9)
    expect(heel[2]).toBeCloseTo(0, 9)

    const capture = captureMateAtSeeds({
      kind: 'fixed',
      ref_a: { part: 'plate', anchor: 'top' },
      ref_b: { part: 'handle', anchor: 'mount' },
      anchors,
    })
    expect(capture!.captured).toEqual({ flip: true, angle: 180 })
    expect(capture!.patch).toEqual({ flip: true, angle: 180 })
  })

  it('picks the flip that holds opposed circle-edge axes', () => {
    const opposed = captureMateAtSeeds({
      kind: 'fixed',
      ref_a: { part: 'flange', anchor: 'hole' },
      ref_b: { part: 'seat', anchor: 'seat' },
      anchors: table(seeded({ flange: IDENTITY, seat: IDENTITY }), CIRCLE_ANCHORS),
    })
    expect(opposed!.captured).toEqual({ flip: true, angle: 180 })

    // The same seat seeded a half turn over reads its axis the way the hole
    // does: no flip and no roll to author.
    const aligned = captureMateAtSeeds({
      kind: 'fixed',
      ref_a: { part: 'flange', anchor: 'hole' },
      ref_b: { part: 'seat', anchor: 'seat' },
      anchors: table(seeded({ flange: IDENTITY, seat: seedAt([0, 0, 0], [180, 0, 0]) }), CIRCLE_ANCHORS),
    })
    expect(aligned!.captured).toEqual({ flip: false, angle: 0 })
  })

  it('lets an explicit flip in the same step win and names the key it beat', () => {
    const anchors = table(seeded({ box_a: IDENTITY, box_b: seedAt([0, 0, 0], [180, 0, 0]) }), BOX_ANCHORS)
    const base = {
      kind: 'fixed' as const,
      ref_a: { part: 'box_a', anchor: 'face' },
      ref_b: { part: 'box_b', anchor: 'face' },
      anchors,
    }
    const beaten = captureMateAtSeeds({ ...base, explicit: { flip: false } })
    expect(beaten!.captured).toEqual({ flip: true, angle: 180, overridden: ['flip'] })
    expect(beaten!.patch.flip).toBe(false)
    expect(beaten!.patch.angle).toBe(180)

    // An explicit value that agrees with the pose beat nothing, so the report
    // stays clean and the patch still carries it.
    const agreed = captureMateAtSeeds({ ...base, explicit: { flip: true, angle: 180 } })
    expect(agreed!.captured).toEqual({ flip: true, angle: 180 })
    expect(agreed!.patch).toEqual({ flip: true, angle: 180 })
  })

  it('lets an explicit angle beat the captured roll and names the key it beat', () => {
    const capture = captureMateAtSeeds({
      kind: 'fixed',
      ref_a: { part: 'box_a', anchor: 'face' },
      ref_b: { part: 'box_b', anchor: 'face' },
      anchors: table(seeded({ box_a: IDENTITY, box_b: seedAt([0, 0, 0], [180, 0, 0]) }), BOX_ANCHORS),
      explicit: { angle: 90 },
    })
    expect(capture!.captured).toEqual({ flip: true, angle: 180, overridden: ['angle'] })
    expect(capture!.patch.flip).toBe(true)
    expect(capture!.patch.angle).toBe(90)
  })

  it('captures nothing for a kind without orientation, an empty slot or a missing anchor', () => {
    const anchors = table(seeded({ box_a: IDENTITY, box_b: IDENTITY }), BOX_ANCHORS)
    expect(captureMateAtSeeds({
      kind: 'spherical',
      ref_a: { part: 'box_a', anchor: 'face' },
      ref_b: { part: 'box_b', anchor: 'face' },
      anchors,
    })).toBeNull()
    expect(captureMateAtSeeds({
      kind: 'fixed',
      ref_a: { part: 'box_a', anchor: 'face' },
      ref_b: { part: '', anchor: '' },
      anchors,
    })).toBeNull()
    expect(captureMateAtSeeds({
      kind: 'fixed',
      ref_a: { part: 'box_a', anchor: 'face' },
      ref_b: { part: 'box_b', anchor: 'gone' },
      anchors,
    })).toBeNull()
  })
})

// ─── the drive: capture lands in the document and in the step result ───

function partDoc(id: string): PartDoc {
  return { version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] } as PartDoc
}

function injected(anchors: Record<string, Anchor>): InjectedBundle {
  const bundle: PartBundle = {
    doc_id: 'injected',
    content_hash: 'h',
    schema: BUNDLE_SCHEMA,
    bodies: [{
      mesh: { vertices: new Float32Array(0), indices: new Uint32Array(0), faceIdsPerTriangle: new Uint32Array(0) },
      edges: [],
      entityAnchors: { faces: [], edges: [], vertices: [] },
    }],
    anchors,
  }
  // No bodies to select against: every ref here is an anchor id, which is the
  // form a stored ref takes anyway.
  return { bundle, bodies: {} }
}

/** A session over injected bundles: no OCC, and the solver is the caller's. */
function sessionWith(anchors: Record<string, Record<string, Anchor>>, doc: AssemblyDoc = emptyDriveAssemblyDoc()) {
  const ids = Object.keys(anchors)
  return createHeadlessAssembly({
    doc,
    parts: new Map(ids.map(id => [id, partDoc(id)])),
    bundleSource: async (docId) => injected(anchors[docId] ?? {}),
  })
}

interface BoxStepOptions {
  capture?: boolean
  // The default seed turns box_b over; false seeds it side by side instead.
  turnedOver?: boolean
  flip?: boolean
  angle?: number
  offset?: number
  refB?: string
}

function boxSteps(options: BoxStepOptions = {}): AssemblyScriptStep[] {
  const { capture = false, turnedOver = true, flip, angle, offset, refB = 'face' } = options
  return [
    { mutation: { type: 'add_part', handle: 'a', part: 'box_a', fixed: true } },
    { mutation: { type: 'add_part', handle: 'b', part: 'box_b', ...(turnedOver ? { rotation: [180, 0, 0] } : { position: [100, 0, 0] }) } },
    { mutation: {
      type: 'add_mate', featureId: 'm1', kind: 'fixed',
      ref_a: { part: 'a', anchor: 'face' }, ref_b: { part: 'b', anchor: refB },
      ...(flip !== undefined && { flip }),
      ...(angle !== undefined && { angle }),
      ...(offset !== undefined && { offset }),
      ...(capture && { capture: true }),
    } },
  ]
}

afterEach(() => {
  setMateSolver(null)
})

describe('the drive captures at the seeds', () => {
  it('freezes the captured flip and angle into the mate and reports them', async () => {
    setMateSolver(makeEchoSolver())
    const session = sessionWith(BOX_ANCHORS)
    const outcome = await session.run(boxSteps({ capture: true }))
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[2]).toMatchObject({ ok: true, captured: { flip: true, angle: 180 } })
    expect(findMate(session.getDoc(), 'm1')).toMatchObject({ flip: true, angle: 180 })
  })

  it('writes nothing without the flag, so a capture-less document keeps its meaning', async () => {
    setMateSolver(makeEchoSolver())
    const session = sessionWith(BOX_ANCHORS)
    const outcome = await session.run(boxSteps())
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[2].captured).toBeUndefined()
    const mate = findMate(session.getDoc(), 'm1')!
    expect(mate).not.toHaveProperty('flip')
    expect(mate).not.toHaveProperty('angle')
  })

  it('reports an unresolvable ref exactly as it would without capture', async () => {
    setMateSolver(makeEchoSolver())
    const withCaptureSession = sessionWith(BOX_ANCHORS)
    const withoutSession = sessionWith(BOX_ANCHORS)
    const withCapture = await withCaptureSession.run(boxSteps({ capture: true, refB: 'nope' }))
    const without = await withoutSession.run(boxSteps({ refB: 'nope' }))
    expect(withCapture.ok).toBe(false)
    expect(withCapture.steps[2].captured).toBeUndefined()
    expect(withCapture.steps[2].error).toEqual(without.steps[2].error)
    expect(withCapture.steps[2].error!.code).toBe('unresolved-ref')
    // The failing step wrote nothing: no mate was appended, and the document
    // the capture run left behind is the one the same script without capture
    // produced.
    expect(findMate(withCaptureSession.getDoc(), 'm1')).toBeUndefined()
    expect(withCaptureSession.getDoc()).toEqual(withoutSession.getDoc())
  })

  it('lets an explicit flip beat the captured one and says so in the result', async () => {
    setMateSolver(makeEchoSolver())
    const session = sessionWith(BOX_ANCHORS)
    const outcome = await session.run(boxSteps({ capture: true, flip: false }))
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[2].captured).toEqual({ flip: true, angle: 180, overridden: ['flip'] })
    expect(findMate(session.getDoc(), 'm1')).toMatchObject({ flip: false, angle: 180 })
  })

  it('lets an explicit angle beat the captured roll and says so in the result', async () => {
    setMateSolver(makeEchoSolver())
    const session = sessionWith(BOX_ANCHORS)
    const outcome = await session.run(boxSteps({ capture: true, angle: 90 }))
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[2].captured).toEqual({ flip: true, angle: 180, overridden: ['angle'] })
    expect(findMate(session.getDoc(), 'm1')).toMatchObject({ flip: true, angle: 90 })
  })

  it("keeps the step's own offset when the capture freezes its orientation", async () => {
    // The capture patch owns only flip/angle; the step's other authored
    // params ride in the same input patch and must survive the merge (a
    // served pin_on_plate with offset 5 silently lost its offset otherwise).
    setMateSolver(makeEchoSolver())
    const session = sessionWith(BOX_ANCHORS)
    const outcome = await session.run(boxSteps({ capture: true, offset: 5 }))
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[2].captured).toEqual({ flip: true, angle: 180 })
    expect(findMate(session.getDoc(), 'm1')).toMatchObject({ flip: true, angle: 180, offset: 5 })
  })

  it('re-measures the re-aimed slot through set_mate_ref with capture', async () => {
    setMateSolver(makeEchoSolver())
    const session = sessionWith(BOX_ANCHORS)
    // Authored against box_b's underside, which meets box_a's face parallel:
    // no flip to write, and the first run leaves the mate bare.
    const first = await session.run(boxSteps({ refB: 'under' }))
    expect(first.ok).toBe(true)
    expect(findMate(session.getDoc(), 'm1')).not.toHaveProperty('flip')

    // Re-aim the one slot at the face that actually meets it: the capture
    // measures the NEW pair, so the contact it freezes is not the one the
    // original refs implied.
    const second = await session.run([{
      mutation: {
        type: 'set_mate_ref', featureId: 'm1', field: 'ref_b',
        ref: { part: 'b', anchor: 'face' }, capture: true,
      },
    }])
    expect(second.ok).toBe(true)
    expect(second.steps[0]).toMatchObject({ ok: true, captured: { flip: true, angle: 180 } })
    expect(findMate(session.getDoc(), 'm1')).toMatchObject({ flip: true, angle: 180 })
  })

  it('deletes an authored flip and angle when the re-measure lands on the default', async () => {
    setMateSolver(makeEchoSolver())
    const session = sessionWith(BOX_ANCHORS)
    // Authored by capture: the turned-over pair freezes flip and angle.
    const first = await session.run(boxSteps({ capture: true }))
    expect(first.ok).toBe(true)
    expect(findMate(session.getDoc(), 'm1')).toMatchObject({ flip: true, angle: 180 })

    // Re-aim at the underside, which meets box_a's face parallel with agreeing
    // canonical frames: the capture measures the default, so its undefined
    // patch keys DELETE the authored values through applyMatePatch rather than
    // leaving stale ones on a mate whose pose no longer implies them.
    const second = await session.run([{
      mutation: {
        type: 'set_mate_ref', featureId: 'm1', field: 'ref_b',
        ref: { part: 'b', anchor: 'under' }, capture: true,
      },
    }])
    expect(second.ok).toBe(true)
    expect(second.steps[0]).toMatchObject({ ok: true, captured: { flip: false, angle: 0 } })
    const mate = findMate(session.getDoc(), 'm1')!
    expect(mate.ref_b).toMatchObject({ part: 'b', anchor: 'under' })
    expect(mate).not.toHaveProperty('flip')
    expect(mate).not.toHaveProperty('angle')
  })

  it('keeps the authored seed with bake: false and reports the pose it kept', async () => {
    setMateSolver(makeTranslateSolver(10))
    const steps = (bake?: boolean): AssemblyScriptStep[] => [
      { mutation: { type: 'add_part', handle: 'left', part: 'box_a', fixed: true } },
      { mutation: { type: 'add_part', handle: 'right', part: 'box_b', position: [30, 0, 0] } },
      { mutation: {
        type: 'add_mate', featureId: 'm1', kind: 'fixed',
        ref_a: { part: 'left', anchor: 'face' }, ref_b: { part: 'right', anchor: 'face' },
      } },
      // The deferred solve moves right to x = 40; the toggle then reads it.
      { mutation: { type: 'update_mate', featureId: 'm1', flip: true } },
      { mutation: { type: 'set_part_fixed', handle: 'left', fixed: false, ...(bake !== undefined && { bake }) } },
    ]
    const rightSeed = (doc: AssemblyDoc) =>
      partInstances(doc).find(instance => instance.handle === 'right')!.transform.tx

    const keptSession = sessionWith(BOX_ANCHORS)
    const kept = await keptSession.run(steps(false))
    expect(kept.ok).toBe(true)
    expect(kept.steps[4]).toMatchObject({ ok: true, poseKept: 'seed' })
    expect(rightSeed(keptSession.getDoc())).toBe(30)
    // The reply still carries the solve; only the document kept its seed.
    expect(keptSession.lastSolve()!.transforms.right.tx).toBeCloseTo(40, 6)

    const bakedSession = sessionWith(BOX_ANCHORS)
    const baked = await bakedSession.run(steps())
    expect(baked.ok).toBe(true)
    expect(baked.steps[4]).toMatchObject({ ok: true, poseKept: 'solved' })
    expect(rightSeed(bakedSession.getDoc())).toBeCloseTo(40, 6)
  })

  it('reports the seed it kept when a fixed toggle runs before any solve', async () => {
    setMateSolver(makeTranslateSolver(10))
    // A saved assembly, reopened: the instances are placed (the last solve
    // moved right to x = 110 while the doc kept its authored seed at 100),
    // but this session has solved nothing yet, so the default bake has no
    // solved pose to write and must not claim it froze one.
    const saved = sessionWith(BOX_ANCHORS)
    const authored = await saved.run(boxSteps({ turnedOver: false }).slice(0, 2))
    expect(authored.ok).toBe(true)
    expect(partInstances(saved.getDoc()).find(instance => instance.handle === 'b')!.transform.tx).toBe(100)

    const loaded = sessionWith(BOX_ANCHORS, saved.getDoc())
    const outcome = await loaded.run([{ mutation: { type: 'set_part_fixed', handle: 'a', fixed: false } }])
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[0]).toMatchObject({ ok: true, poseKept: 'seed' })
    expect(partInstances(loaded.getDoc()).find(instance => instance.handle === 'b')!.transform.tx).toBe(100)
  })
})

// ─── the real mate solver: the capture is what the solve holds ───

/** A pose's world-space image of a local direction, for the axis claims. */
function worldAxis(transform: Transform3D, local: [number, number, number]): [number, number, number] {
  const world = rotateVector([transform.qx, transform.qy, transform.qz, transform.qw], local)
  return [world[0], world[1], world[2]]
}

/** Whether a solve left the seeded pose at all, past solver-scale noise. */
function movedFromSeed(solved: Transform3D, seed: Transform3D): boolean {
  const keys = ['tx', 'ty', 'tz', 'qx', 'qy', 'qz', 'qw'] as const
  return keys.some(key => Math.abs(solved[key] - seed[key]) > 1e-3)
}

function poseOf(session: { lastSolve(): { transforms: Record<string, Transform3D> } | null }, handle: string): Transform3D {
  const response = session.lastSolve()
  if (!response) throw new Error('the run did not solve')
  return response.transforms[handle]
}

describeSolve('the captured orientation is what the solve holds', () => {
  // Before every test, not once: the outer afterEach clears the solver after
  // each one, and a solve that silently ran with no solver would hold the seed
  // for the wrong reason.
  beforeEach(() => {
    if (solveMate) setMateSolver(solveMate)
  })

  it("holds the handle's seed pose, legs along world -Y, once captured", async () => {
    const steps = (capture: boolean): AssemblyScriptStep[] => [
      { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
      { mutation: { type: 'add_part', handle: 'handle', part: 'handle', rotation: [-90, 0, 0] } },
      { mutation: {
        type: 'add_mate', featureId: 'm1', kind: 'fixed',
        ref_a: { part: 'plate', anchor: 'top' }, ref_b: { part: 'handle', anchor: 'mount' },
        ...(capture && { capture: true }),
      } },
    ]

    const heldSession = sessionWith(HANDLE_ANCHORS)
    const held = await heldSession.run(steps(true))
    expect(held.ok).toBe(true)
    expect(held.steps[2].captured).toEqual({ flip: true, angle: 180 })
    // The mate really solved against the captured values: it resolved and it
    // is satisfied, so the pose assertions below mean something.
    const heldMate = heldSession.lastSolve()!.status.mates.m1
    expect(heldMate).toMatchObject({ stale: false })
    expect(heldMate.residual ?? Infinity).toBeLessThan(1e-6)
    const seed = partInstances(heldSession.getDoc()).find(instance => instance.handle === 'handle')!.transform
    const solved = poseOf(heldSession, 'handle')
    expect(solved.tx).toBeCloseTo(seed.tx, 6)
    expect(solved.ty).toBeCloseTo(seed.ty, 6)
    expect(solved.tz).toBeCloseTo(seed.tz, 6)
    expect(solved.qx).toBeCloseTo(seed.qx, 6)
    expect(solved.qy).toBeCloseTo(seed.qy, 6)
    expect(solved.qz).toBeCloseTo(seed.qz, 6)
    expect(solved.qw).toBeCloseTo(seed.qw, 6)
    // The legs the seed was chosen for: still along world -Y after the solve,
    // and the mount axis still anti-parallel to the plate's +Z face.
    expect(worldAxis(solved, [0, 0, -20])[1]).toBeCloseTo(-20, 6)
    expect(worldAxis(solved, [0, 1, 0])[2]).toBeCloseTo(-1, 6)

    // Without capture the same script does not hold that seed: the mate has
    // no flip and no angle, so the solve walks the handle off the pose it was
    // placed at instead of freezing it.
    const movedSession = sessionWith(HANDLE_ANCHORS)
    const moved = await movedSession.run(steps(false))
    expect(moved.ok).toBe(true)
    expect(movedFromSeed(poseOf(movedSession, 'handle'), seed)).toBe(true)
  }, 60_000)

  it('holds opposed circle-edge axes at the seed once captured', async () => {
    const steps = (capture: boolean): AssemblyScriptStep[] => [
      { mutation: { type: 'add_part', handle: 'flange', part: 'flange', fixed: true } },
      { mutation: { type: 'add_part', handle: 'seat', part: 'seat' } },
      { mutation: {
        type: 'add_mate', featureId: 'm1', kind: 'fixed',
        ref_a: { part: 'flange', anchor: 'hole' }, ref_b: { part: 'seat', anchor: 'seat' },
        ...(capture && { capture: true }),
      } },
    ]

    const heldSession = sessionWith(CIRCLE_ANCHORS)
    const held = await heldSession.run(steps(true))
    expect(held.ok).toBe(true)
    expect(held.steps[2].captured).toEqual({ flip: true, angle: 180 })
    const heldMate = heldSession.lastSolve()!.status.mates.m1
    expect(heldMate).toMatchObject({ stale: false })
    expect(heldMate.residual ?? Infinity).toBeLessThan(1e-6)
    const seed = partInstances(heldSession.getDoc()).find(instance => instance.handle === 'seat')!.transform
    const solved = poseOf(heldSession, 'seat')
    expect(solved.tx).toBeCloseTo(seed.tx, 6)
    expect(solved.qx).toBeCloseTo(seed.qx, 6)
    expect(solved.qz).toBeCloseTo(seed.qz, 6)
    expect(solved.qw).toBeCloseTo(seed.qw, 6)
    // The hole's edge axis still reads +Z and the seat's -Z: exactly the
    // opposed pair the captured flip holds.
    expect(worldAxis(solved, [0, 0, -1])[2]).toBeCloseTo(-1, 6)

    const movedSession = sessionWith(CIRCLE_ANCHORS)
    const moved = await movedSession.run(steps(false))
    expect(moved.ok).toBe(true)
    expect(movedFromSeed(poseOf(movedSession, 'seat'), seed)).toBe(true)
  }, 60_000)
})
