// @vitest-environment node
//
// The multisection sweep's solid used to be handed back by the pipe-shell
// attempt UNTRACKED. Every plausibility gate after the build (one solid, right
// side out, plausible volume) and a throwing lineage pass therefore stranded
// it: the OCC handle lived on past the operation, one refused build at a time.
//
// The refusal is forced at the lineage pass, the trap the review named, while
// the sweep itself is the real OCC one: two square sections on a line spine.
//
// Skips when opencascade.js is absent.
import { describe, it, expect, vi } from 'vitest'
import { loadOcc } from '../loadOcc'
import { CountingScope } from '../countingScope'
import { makeLineEdge } from '../primitives'
import { sweepSectionsWithLineage, type SweepSection } from '../sweepSections'
import type { Disposable } from '../disposeScope'
import type { OccMaybeShape } from '../occTypes'
import type { LoopEdge } from '../../profileLoops'
import type { PlaneLike } from '../../features/shared/planes'

vi.mock('../prismLineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prismLineage')>()
  return {
    ...actual,
    buildPrismLineageMap: () => {
      throw new Error('sweep: lineage refused (forced by the leak test)')
    },
  }
})

const oc = await loadOcc()

/** Keeps the scope's own bookkeeping and also remembers the first solid it
 *  tracked, so the test names the pipe-shell result instead of guessing at a
 *  track count. */
class CapturingScope extends CountingScope {
  readonly tracked: Disposable[] = []
  builtSolid: Disposable | null = null
  constructor(private readonly solidType: number) {
    super()
  }
  override track<T extends Disposable>(obj: T): T {
    this.tracked.push(obj)
    const type = (obj as OccMaybeShape).ShapeType?.()
    if (type !== undefined && type.value === this.solidType) this.builtSolid = obj
    return super.track(obj)
  }
}

const Z_PLANE: PlaneLike = {
  origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
}

function squareLoop(half: number): LoopEdge[] {
  const c: [number, number][] = [[-half, -half], [half, -half], [half, half], [-half, half]]
  return c.map((p, i) => {
    const q = c[(i + 1) % c.length]
    return { kind: 'line', start: p, end: q } as LoopEdge
  })
}

function section(z: number, pick: number): SweepSection {
  return {
    sketchId: 'sk1',
    plane: { ...Z_PLANE, origin: [0, 0, z] },
    loop: squareLoop(1),
    tangent: [0, 0, 1],
    pick,
  }
}

describe.skipIf(!oc)('a refused multisection sweep frees its solid (real OCC)', () => {
  it('keeps the built solid tracked until the caller owns it', () => {
    const scope = new CapturingScope(oc!.TopAbs_ShapeEnum.TopAbs_SOLID.value)
    try {
      const spine = makeLineEdge(oc!, scope, [0, 0, 0], [0, 0, 10])
      expect(() =>
        sweepSectionsWithLineage(oc!, scope, [section(0, 1), section(10, 2)], [spine], 'ex1'),
      ).toThrow(/lineage refused/)
      // The solid built before the refusal is still the scope's: dispose is
      // the only thing left that can free it.
      expect(scope.builtSolid).not.toBeNull()
      expect(scope.isTracked(scope.builtSolid as Disposable)).toBe(true)
    } finally {
      scope.dispose()
    }
    // A refused sweep leaves no live handle: the scope owning the solid is the
    // whole difference between a bounded build and one leaked per refusal.
    expect(scope.size()).toBe(0)
  })
})
