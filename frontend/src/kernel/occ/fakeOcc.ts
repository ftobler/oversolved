/**
 * In-memory [[OccSpikeModule]] double for the always-on leak gate.
 *
 * The real opencascade.js build is a gitignored, opt-in 66 MB artifact (see
 * `loadOcc.ts`), so the gated spike test only runs locally. This double lets
 * the orchestration's memory discipline be exercised unconditionally in CI: it
 * accounts for every "owned" embind object it hands out and decrements on
 * `delete()`, so a single stranded handle shows up as `ledger.live > 0`.
 *
 * Ownership model mirrors what the real build proved safe during the spike:
 *   - Constructed objects and copy-returning methods (Wire/Face/Shape/Face_1,
 *     Generated list + its drained sub-shapes, the triangulation handle) are
 *     OWNED: counted, must be deleted.
 *   - `Explorer.Current()` and `Handle::get()` return BORROWED references that
 *     the caller does not delete; they are not counted.
 * The fixed shape (square extrude) yields 6 faces / 12 triangles / 4 profile
 * edges / 4 generated sub-shapes, matching the real module.
 */

import type {
  OccDisposable,
  OccExplorer,
  OccFaceBuilder,
  OccListOfShape,
  OccSpikeModule,
  OccPolygonBuilder,
  OccPrismBuilder,
  OccShape,
  OccShapeEnumValue,
  OccTriangulationHandleBasic,
} from './occTypes'

export class Ledger {
  live = 0
  created = 0
  doubleDeletes = 0

  owned(): OccDisposable {
    this.live++
    this.created++
    let deleted = false
    return {
      delete: () => {
        if (deleted) {
          this.doubleDeletes++
          return
        }
        deleted = true
        this.live--
      },
      isDeleted: () => deleted,
    }
  }
}

const FACE_KIND = { kind: 'FACE' } as const
const EDGE_KIND = { kind: 'EDGE' } as const
const SHAPE_KIND = { kind: 'SHAPE' } as const

function borrowed(): OccShape {
  // Borrowed references are not deleted by the caller and not counted; a delete
  // here would be a bug, so make it loud.
  return {
    delete: () => {
      throw new Error('FakeOcc: caller deleted a borrowed reference')
    },
    isDeleted: () => false,
  }
}

export interface FakeOccModule extends OccSpikeModule {
  ledger: Ledger
}

export function makeFakeOcc(): FakeOccModule {
  const ledger = new Ledger()
  const owned = () => ledger.owned()

  class Polygon implements OccPolygonBuilder {
    private readonly d = owned()
    private points = 0
    Add_1(): void {
      this.points++
    }
    Close(): void {}
    Wire(): OccShape {
      return owned()
    }
    delete(): void {
      this.d.delete()
    }
    isDeleted(): boolean {
      return this.d.isDeleted?.() ?? false
    }
  }

  class FaceBuilder implements OccFaceBuilder {
    private readonly d = owned()
    Face(): OccShape {
      return owned()
    }
    IsDone(): boolean {
      return true
    }
    Add(_wire: OccShape): void {
      void _wire
    }
    delete(): void {
      this.d.delete()
    }
  }

  class PrismBuilder implements OccPrismBuilder {
    private readonly d = owned()
    Shape(): OccShape {
      return owned()
    }
    Generated(): OccListOfShape {
      return new ListOfShape(1)  // one side wall per profile edge
    }
    delete(): void {
      this.d.delete()
    }
  }

  class ListOfShape implements OccListOfShape {
    private readonly d = owned()
    private n: number
    constructor(n: number) {
      this.n = n
    }
    Size(): number {
      return this.n
    }
    First_1(): OccShape {
      return owned()
    }
    RemoveFirst(): void {
      if (this.n > 0) this.n--
    }
    Append_1(): void {
      this.n++
    }
    delete(): void {
      this.d.delete()
    }
  }

  class Explorer implements OccExplorer {
    private readonly d = owned()
    private i = 0
    private readonly count: number
    constructor(_shape: OccShape, toFind: OccShapeEnumValue) {
      const kind = (toFind as { kind?: string }).kind
      this.count = kind === 'EDGE' ? 4 : kind === 'FACE' ? 6 : 0
    }
    More(): boolean {
      return this.i < this.count
    }
    Next(): void {
      this.i++
    }
    Current(): OccShape {
      return borrowed()
    }
    delete(): void {
      this.d.delete()
    }
  }

  class Mesher implements OccDisposable {
    private readonly d = owned()
    delete(): void {
      this.d.delete()
    }
  }

  class Location implements OccDisposable {
    private readonly d = owned()
    delete(): void {
      this.d.delete()
    }
  }

  class TriangulationHandle implements OccTriangulationHandleBasic {
    private readonly d = owned()
    IsNull(): boolean {
      return false
    }
    get() {
      return { NbTriangles: () => 2 }  // 2 triangles per quad face
    }
    delete(): void {
      this.d.delete()
    }
  }

  const fake: FakeOccModule = {
    ledger,
    gp_Pnt_3: class {
      private readonly d = owned()
      delete(): void {
        this.d.delete()
      }
    },
    gp_Vec_4: class {
      private readonly d = owned()
      delete(): void {
        this.d.delete()
      }
    },
    BRepBuilderAPI_MakePolygon_1: Polygon,
    BRepBuilderAPI_MakeFace_15: FaceBuilder,
    BRepPrimAPI_MakePrism_1: PrismBuilder,
    BRepMesh_IncrementalMesh_2: Mesher,
    TopExp_Explorer_2: Explorer,
    TopAbs_ShapeEnum: {
      TopAbs_FACE: FACE_KIND,
      TopAbs_EDGE: EDGE_KIND,
      TopAbs_SHAPE: SHAPE_KIND,
    },
    TopoDS: {
      Face_1: () => owned(),
    },
    TopLoc_Location_1: Location,
    BRep_Tool: {
      Triangulation: () => new TriangulationHandle(),
    },
  }
  return fake
}
