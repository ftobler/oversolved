// @vitest-environment node
//
// The boolean identity check of the robustness fuzz: for a seeded primitive
// pair A, B the volumes must satisfy V(A u B) + V(A n B) = V(A) + V(B). The
// identity is how a fuzz catches a boolean that silently loses or invents
// material without either operand being wrong on its own: a vanished fuse
// intersection and an invented intersection cannot both be right. Both
// operations run through booleanWithDiff, the production boolean producer
// (history classification, cylinder canonicalization, the unify clean) with
// its soundness gate, so a pair the kernel cannot boolean at all surfaces as a
// BooleanSoundnessError refusal rather than an impossible shape. Refusals are
// reported, capped, and pinned: the regressions below assert which exact
// tangencies refuse and which the production retry recovers.
//
// Placements are grid-snapped and drawn to overlap, so flush faces and tangent
// contacts occur as often as crossing overlaps. The 0.2% band absorbs OCC's
// integrator noise and nothing else; measured deviations are six orders
// inside it.
//
// Seeds are sized by ROBUSTNESS_FUZZ_SEEDS (a quarter of the chain sweep, at
// least the bounded default) so `just fuzz-geometry` widens both.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { DisposeScope } from '@/kernel/occ/disposeScope'
import { makeBoxAt, makeCylinder, type Vec3 } from '@/kernel/occ/primitives'
import { booleanWithDiff, volumeOf, BooleanSoundnessError } from '@/kernel/occ/booleans'
import { makePrng } from '@/hooks/__tests__/fuzzHarness'
import { makeSphereAt } from './chain'
import { FUZZ_GRID_MM } from './recipe'
import { yieldToEventLoop } from '../yieldToEventLoop'
import type { OccModule, OccShape } from '@/kernel/occ/occTypes'

const oc = await loadOcc()

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

const CHAIN_SEEDS = envInt('ROBUSTNESS_FUZZ_SEEDS', 24)
// The floor is 32, not a quarter of the chain range: the first 32 seeds are the
// smallest range measured to draw all nine primitive pairings, and the
// coverage assertion below needs them. The floor applies to an explicit
// override too, so a small value cannot fail the pairing assertion for a
// reason unrelated to the kernel.
const SEEDS = Math.max(32, envInt('ROBUSTNESS_FUZZ_IDENTITIES', Math.ceil(CHAIN_SEEDS / 4)))

// A 375-seed sweep holds the event loop for over a minute; the stall guard
// fails that locally (CI only warns), and the worker's RPC reply needs a
// macrotask. Sixteen seeds per turn keeps every gap far below the 30 s limit
// without measurably slowing the sweep.
const YIELD_EVERY = 16

function drawInt(rnd: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1))
}

function drawOf<T>(rnd: () => number, values: readonly T[]): T {
  return values[Math.floor(rnd() * values.length)]
}

interface Primitive {
  kind: 'box' | 'cylinder' | 'sphere'
  // [x, y, z] of the bounding box; cylinder/sphere carry their diameter in x.
  size: Vec3
}

function drawPrimitive(rnd: () => number): Primitive {
  const kind = drawOf(rnd, ['box', 'cylinder', 'sphere'] as const)
  if (kind === 'box') {
    const g = (n: number): number => n * FUZZ_GRID_MM
    return { kind, size: [g(drawInt(rnd, 4, 7)), g(drawInt(rnd, 4, 7)), g(drawInt(rnd, 4, 7))] }
  }
  const d = drawInt(rnd, 4, 7) * FUZZ_GRID_MM
  return { kind, size: kind === 'cylinder' ? [d, d, drawInt(rnd, 4, 7) * FUZZ_GRID_MM] : [d, d, d] }
}

function primitiveBounds(p: Primitive, min: Vec3): { min: Vec3; max: Vec3 } {
  return { min, max: [min[0] + p.size[0], min[1] + p.size[1], min[2] + p.size[2]] }
}

function buildPrimitive(ocModule: OccModule, scope: DisposeScope, p: Primitive, min: Vec3): OccShape {
  if (p.kind === 'box') return scope.track(makeBoxAt(ocModule, scope, min, p.size[0], p.size[1], p.size[2]))
  if (p.kind === 'cylinder') {
    const r = p.size[0] / 2
    return scope.track(makeCylinder(ocModule, scope, [min[0] + r, min[1] + r, min[2]], [0, 0, 1], r, p.size[2]))
  }
  const r = p.size[0] / 2
  return scope.track(makeSphereAt(ocModule, scope, [min[0] + r, min[1] + r, min[2] + r], r))
}

interface PairDraw {
  a: Primitive
  b: Primitive
  bMin: Vec3
}

/**
 * One seed's full pair draw, shared by the sweep and the pinned regressions so
 * a pin keeps testing the exact geometry its seed produced. The second
 * placement is either a flush contact on a face of A (B's min corner sits on
 * it) or a crossing overlap around A's centre, both nudged on the grid.
 */
function drawPair(seed: number): PairDraw {
  const rnd = makePrng(seed)
  const a = drawPrimitive(rnd)
  const b = drawPrimitive(rnd)
  const aMin: Vec3 = [0, 0, 0]
  const aBox = primitiveBounds(a, aMin)
  const cell = (n: number): number => n * FUZZ_GRID_MM
  const bMin: Vec3 = rnd() < 0.3
    ? [
        rnd() < 0.5 ? aBox.max[0] : aBox.min[0] - b.size[0],
        cell(drawInt(rnd, -2, 2)),
        cell(drawInt(rnd, -2, 2)),
      ]
    : [
        (aBox.min[0] + aBox.max[0]) / 2 - b.size[0] / 2 + cell(drawInt(rnd, -2, 2)),
        (aBox.min[1] + aBox.max[1]) / 2 - b.size[1] / 2 + cell(drawInt(rnd, -2, 2)),
        (aBox.min[2] + aBox.max[2]) / 2 - b.size[2] / 2 + cell(drawInt(rnd, -2, 2)),
      ]
  return { a, b, bMin }
}

function buildPair(scope: DisposeScope, draw: PairDraw): { shapeA: OccShape; shapeB: OccShape } {
  if (!oc) throw new Error('unreachable: skipIf guards this')
  return {
    shapeA: buildPrimitive(oc, scope, draw.a, [0, 0, 0]),
    shapeB: buildPrimitive(oc, scope, draw.b, draw.bMin),
  }
}

// One second per identity seed over a 60 s floor: the measured cost is a
// third of that, and a wide range (1250 seeds at the 5000 chain scale) needs
// the budget to scale with it.
const IDENTITY_TIMEOUT_MS = Math.min(60 * 60_000, 60_000 + SEEDS * 1_000)

describe.skipIf(!oc)('boolean identities on primitive pairs (real OCC)', () => {
  it('V(A u B) + V(A n B) = V(A) + V(B) within 0.2%, over a seeded range', { timeout: IDENTITY_TIMEOUT_MS }, async () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const failures: string[] = []
    const refusals: string[] = []
    const kindsSeen = new Set<string>()

    for (let seed = 0; seed < SEEDS; seed++) {
      if (seed > 0 && seed % YIELD_EVERY === 0) await yieldToEventLoop()
      const draw = drawPair(seed)
      kindsSeen.add(`${draw.a.kind}+${draw.b.kind}`)

      const scope = new DisposeScope()
      try {
        const { shapeA, shapeB } = buildPair(scope, draw)
        const va = volumeOf(oc, scope, shapeA)
        const vb = volumeOf(oc, scope, shapeB)
        let vf: number
        let vc: number
        try {
          const fused = booleanWithDiff(oc, scope, shapeA, shapeB, 'fuse')
          const common = booleanWithDiff(oc, scope, shapeA, shapeB, 'common')
          vf = volumeOf(oc, scope, fused.shape)
          vc = volumeOf(oc, scope, common.shape)
        } catch (e) {
          // The pair's kernel refusal, not a check failure: the soundness gate
          // exists because of these pairs, and the pinned regressions below
          // keep their refusal exact.
          if (e instanceof BooleanSoundnessError) {
            refusals.push(`seed ${seed} (${draw.a.kind} u/n ${draw.b.kind}): ${e.message}`)
            continue
          }
          throw e
        }

        const total = va + vb
        const identity = Math.abs(vf + vc - total)
        const tol = 0.002 * total + 1e-6
        const label = `seed ${seed} (${draw.a.kind} u/n ${draw.b.kind})`
        if (!Number.isFinite(va) || !Number.isFinite(vb) || !Number.isFinite(vf) || !Number.isFinite(vc)) {
          failures.push(`${label}: non-finite volume Va=${va} Vb=${vb} Vf=${vf} Vc=${vc}`)
        } else if (va <= 0 || vb <= 0) {
          failures.push(`${label}: a primitive volume is not positive: Va=${va} Vb=${vb}`)
        } else if (vc < -1e-9 || vf <= 0) {
          failures.push(`${label}: impossible result volumes: Vf=${vf} Vc=${vc}`)
        } else if (identity > tol) {
          failures.push(`${label}: V(AuB)+V(AnB)=${vf + vc} but V(A)+V(B)=${total} (off by ${identity}, band ${tol})`)
        }
        // The identity also says the intersection cannot exceed either operand
        // and the union cannot be smaller than the larger one.
        if (vc > Math.min(va, vb) * 1.002 + 1e-6) {
          failures.push(`${label}: V(AnB)=${vc} exceeds min(V(A),V(B))=${Math.min(va, vb)}`)
        }
        if (vf < Math.max(va, vb) * 0.998 - 1e-6) {
          failures.push(`${label}: V(AuB)=${vf} is below max(V(A),V(B))=${Math.max(va, vb)}`)
        }
      } catch (e) {
        failures.push(`seed ${seed}: the boolean threw: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        scope.dispose()
      }
    }

    // A refusal means the kernel could not compute the pair and production
    // refused instead of shipping a corrupt shape. The cap catches a gate that
    // starts refusing everything; the log keeps each refusal visible in a green
    // run.
    const refusalCap = Math.max(2, Math.ceil(SEEDS / 10))
    console.log(`[robustness-fuzz] identity sweep: ${SEEDS} seeds, ${refusals.length} refused (cap ${refusalCap})`)
    for (const refusal of refusals) console.log(`[robustness-fuzz] refused: ${refusal}`)
    expect(refusals.length).toBeLessThanOrEqual(refusalCap)
    expect(failures).toEqual([])
    // All nine primitive pairings show up across the seeded range.
    expect(kindsSeen.size).toBe(9)
  })
})

// The exact pairs behind the gate. Seed 3's sphere centre lies exactly on the
// cylinder's lateral surface (the cylinder axis is tangent to the sphere)
// while the bodies overlap: the first boolean over the fresh pair drops an
// operand (its result integrates to 2.3e-13), so this is the retry the
// soundness gate must recover. The rest are
// a cylinder lateral surface exactly on a box face plane: the kernel's fuse
// comes back as the target minus the tool with the wrong sign, no retry
// repairs it, and the gate must refuse rather than ship it. The seeds come
// from the identity sweep above; the draws reproduce through drawPair.
describe.skipIf(!oc)('the boolean soundness gate on exact tangencies (real OCC)', () => {
  it('recovers the sphere touching a cylinder wall (seed 3)', { timeout: 120_000 }, () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const scope = new DisposeScope()
    try {
      const { shapeA, shapeB } = buildPair(scope, drawPair(3))
      const va = volumeOf(oc, scope, shapeA)
      const vb = volumeOf(oc, scope, shapeB)
      const fused = booleanWithDiff(oc, scope, shapeA, shapeB, 'fuse')
      const common = booleanWithDiff(oc, scope, shapeA, shapeB, 'common')
      const vf = volumeOf(oc, scope, fused.shape)
      const vc = volumeOf(oc, scope, common.shape)
      const total = va + vb
      expect(Math.abs(vf + vc - total)).toBeLessThanOrEqual(0.002 * total + 1e-6)
    } finally {
      scope.dispose()
    }
  })

  it.each([50, 85, 139, 157, 164, 186])(
    'refuses the lateral line contact fuse instead of an inverted solid (seed %i)',
    { timeout: 120_000 },
    (seed) => {
      if (!oc) throw new Error('unreachable: skipIf guards this')
      const scope = new DisposeScope()
      try {
        const { shapeA, shapeB } = buildPair(scope, drawPair(seed))
        let refusal: unknown
        try {
          booleanWithDiff(oc, scope, shapeA, shapeB, 'fuse')
        } catch (e) {
          refusal = e
        }
        expect(refusal).toBeInstanceOf(BooleanSoundnessError)
        expect((refusal as Error).message).toMatch(/unsound result/)
        // The intersection of a zero-measure contact is an empty but sound
        // result, and passes the gate.
        const common = booleanWithDiff(oc, scope, shapeA, shapeB, 'common')
        expect(volumeOf(oc, scope, common.shape)).toBeLessThanOrEqual(1e-6)
      } finally {
        scope.dispose()
      }
    },
  )
})
