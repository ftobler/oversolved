/**
 * The TS facade over the Rust pure-geometry crate (`geom-core`).
 *
 * The functions keep the signatures the kernel has always called, but run in
 * WASM: sampling, signed area, the point-in-polygon test, the centroid,
 * containment and subdivision all cross the `profile_loops_bytes` wire. The
 * TypeScript implementations were deleted once these reached parity; the
 * golden fixture `geom-core/tests/fixtures/profile_loops.json` pins the
 * behaviour they had, and `profileLoopsGolden.test.ts` replays it on every run.
 *
 * The bytes function is installed wherever the sketch package is loaded, so no
 * caller has to remember it. In the browser that is `initSketchSolver` (the
 * OCC/solver Worker, where every caller lives); on the node side the package
 * loaders install it (`loadSolver`/`loadSolverFresh`), and the two forked
 * runners (`solveTimeout`, `chainTimeout`) wire it with the rest of the
 * package. The vitest setup file also installs it at module scope, because
 * `postRegister`'s fixture sweep and `measureReal`'s `beforeAll` sample a loop
 * before any per-test hook runs. Nothing on the UI main thread needs these
 * functions, so no WASM package is loaded there for them (see the main-thread
 * decision in `feature/knowledgebase.agent.md`, geom-core section).
 */

import type { ProfileLoopsBytes } from '@/wasm-kernel/wasmTypes'
import {
  encodeProfileLoops,
  ProfileLoopsReply,
  ProfileLoopOp,
  type LoopEdge,
} from '@/wasm-kernel/profileLoopsCodec'

// The loop-edge dict type lives with the wire codec (one `Record<string,
// unknown>` in production, the shape the topology dicts already are); the
// kernel re-exports it, so callers keep importing it from `kernel/profileLoops`.
export type { LoopEdge } from '@/wasm-kernel/profileLoopsCodec'

let installed: ProfileLoopsBytes | null = null

/** Install the loaded `profile_loops_bytes` export. Null uninstalls, so a
 *  trapped sketch instance does not leave a stale function behind. */
export function setProfileLoopsBytes(bytes: ProfileLoopsBytes | null): void {
  installed = bytes
}

/** Whether the Rust core is wired (a fresh checkout without `just wasm` is not). */
export function profileLoopsAvailable(): boolean {
  return installed !== null
}

function call(input: Uint8Array): Uint8Array {
  if (installed === null) {
    throw new Error('profile loops: Rust core not initialised (run `just wasm`)')
  }
  return installed(input)
}

function reply(input: Uint8Array): ProfileLoopsReply {
  return new ProfileLoopsReply(call(input))
}

/** The old samplers returned `[]` for an edge of another kind or one missing
 *  the fields that kind samples from. The wire codec refuses a half-formed edge
 *  (the topology writer emits complete ones), so the facade keeps the guard the
 *  callers and their tests already relied on. */
function malformed(e: LoopEdge, required: readonly string[]): boolean {
  for (const key of required) {
    const v = e[key]
    if (!Array.isArray(v) || v.length < 2) return true
  }
  return false
}

/** n interior points spread along an arc edge (n>=1); empty if not an arc. */
export function arcSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e['kind'] !== 'arc' || malformed(e, ['center'])) return []
  return reply(encodeProfileLoops(ProfileLoopOp.arcSamples, n, [[e]])).points()
}

/** n interior points along a spline edge; empty if not one. */
export function splineSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e['kind'] !== 'spline' || malformed(e, ['start', 'c1', 'c2', 'end'])) return []
  return reply(encodeProfileLoops(ProfileLoopOp.splineSamples, n, [[e]])).points()
}

/** n interior points along a fit-spline chain edge; empty if not one. */
export function fitSplineSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e['kind'] !== 'fit_spline') return []
  const poles = e['poles']
  const knots = e['knots']
  if (!Array.isArray(poles) || !Array.isArray(knots) || knots.length < 2) return []
  return reply(encodeProfileLoops(ProfileLoopOp.fitSplineSamples, n, [[e]])).points()
}

/** n interior points along an elliptical-arc edge; empty if not one. */
export function ellipseArcSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e['kind'] !== 'ellipse_arc' || malformed(e, ['center'])) return []
  return reply(encodeProfileLoops(ProfileLoopOp.ellipseArcSamples, n, [[e]])).points()
}

/** n points spread around a full closed ellipse edge; empty if not one. */
export function ellipseSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e['kind'] !== 'ellipse' || malformed(e, ['center'])) return []
  return reply(encodeProfileLoops(ProfileLoopOp.ellipseSamples, n, [[e]])).points()
}

/** Polygon point list from a loop, inserting arc/spline/ellipse sample points. */
export function loopPts(loop: LoopEdge[], arcSamples = 1): number[][] {
  return reply(encodeProfileLoops(ProfileLoopOp.loopPts, arcSamples, [loop])).points()
}

/** Signed 2D area via the shoelace formula. Positive = CCW. */
export function loopSignedArea(loop: LoopEdge[], arcSamples = 1): number {
  return reply(encodeProfileLoops(ProfileLoopOp.signedArea, arcSamples, [loop])).f64()
}

/** Ray-casting point-in-polygon test against a 2D loop, at `arcSamples`. */
export function pointInLoop(pt: number[], loop: LoopEdge[], arcSamples = 1): boolean {
  return reply(encodeProfileLoops(ProfileLoopOp.pointInLoop, arcSamples, [loop], pt)).bool()
}

/** Area-weighted centroid of a 2D loop polygon. */
export function loopCentroid(loop: LoopEdge[]): number[] {
  return reply(encodeProfileLoops(ProfileLoopOp.centroid, 0, [loop])).point()
}

/**
 * Containment analysis: for each loop, its nesting `depth` and its immediate
 * `container` (the smallest strictly larger loop that encloses it, or -1).
 * `arcSamples` is the polygon count both the areas and the point tests use.
 */
export function loopContainment(
  loops: LoopEdge[][],
  arcSamples = 1,
): { depth: number[]; container: number[] } {
  const r = reply(encodeProfileLoops(ProfileLoopOp.containment, arcSamples, loops))
  const n = r.u32()
  const depth: number[] = []
  const container: number[] = []
  for (let i = 0; i < n; i++) {
    depth.push(r.u32())
    const c = r.u32()
    container.push(c === 0xffffffff ? -1 : c)
  }
  return { depth, container }
}

/**
 * Planar subdivision: every loop bounds its own face whose holes are the loops
 * immediately nested inside it. The old signature returned the loop dicts
 * themselves; the wire returns indices and the facade maps them back, so a
 * caller cannot notice the crossing.
 */
export function subdivideLoops(loops: LoopEdge[][]): [LoopEdge[], LoopEdge[][]][] {
  const r = reply(encodeProfileLoops(ProfileLoopOp.subdivide, 0, loops))
  const n = r.u32()
  const out: [LoopEdge[], LoopEdge[][]][] = []
  for (let i = 0; i < n; i++) {
    const outer = r.u32()
    const holes = r.u32()
    const group: LoopEdge[][] = []
    for (let h = 0; h < holes; h++) group.push(loops[r.u32()])
    out.push([loops[outer], group])
  }
  return out
}
