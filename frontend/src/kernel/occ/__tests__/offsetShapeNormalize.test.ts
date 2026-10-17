// Pure unit coverage for offsetSolid's result normalization (kernel/occ/
// offsetShape.ts). The COMPOUND / "anything else" rejection (plan step 2) could
// not be reproduced with a real slotted box on this OCCT build: every slotted
// tool offsets to either a valid solid or to IsDone() === false, so the real
// fixture drives the safer IsDone path (offsetShapeReal.test.ts). This test
// drives the branch directly with a minimal fake oc whose offset op succeeds and
// returns a top-level COMPOUND, matching the reviewer's ask to keep the
// non-solid/non-shell rejection covered.
import { describe, it, expect } from 'vitest'
import { DisposeScope } from '../disposeScope'
import { offsetSolid, OffsetError } from '../offsetShape'
import type { OccModule, OccShape, OccEnumValue } from '../occTypes'

const SOLID = { value: 1 } as unknown as OccEnumValue
const SHELL = { value: 2 } as unknown as OccEnumValue
const COMPOUND = { value: 3 } as unknown as OccEnumValue

function fakeShape(shapeType: OccEnumValue): OccShape {
  return { ShapeType: () => shapeType, delete: (): void => {} } as unknown as OccShape
}

/** A fake oc whose offset op reports success and hands back `resultType`. */
function fakeOcc(resultType: OccEnumValue): OccModule {
  return {
    BRepOffsetAPI_MakeOffsetShape_1: function () {
      return {
        PerformByJoin: (): void => {},
        IsDone: (): boolean => true,
        Shape: (): OccShape => fakeShape(resultType),
        Generated: () => ({ Size: () => 0, delete: (): void => {} }),
        delete: (): void => {},
      }
    },
    BRepOffset_Mode: { BRepOffset_Skin: { value: 0 } },
    GeomAbs_JoinType: { GeomAbs_Intersection: { value: 0 } },
    TopAbs_ShapeEnum: { TopAbs_SOLID: SOLID, TopAbs_SHELL: SHELL, TopAbs_SHAPE: { value: 9 } },
  } as unknown as OccModule
}

describe('offsetSolid result normalization', () => {
  it('refuses a result that is neither a solid nor a single shell (the COMPOUND case)', () => {
    const scope = new DisposeScope()
    try {
      const oc = fakeOcc(COMPOUND)
      expect(() => offsetSolid(oc, scope, fakeShape(COMPOUND), 0.1)).toThrow(OffsetError)
      expect(() => offsetSolid(oc, scope, fakeShape(COMPOUND), 0.1)).toThrow(/did not produce a solid or a single shell/)
    } finally {
      scope.dispose()
    }
  })
})
