/**
 * The spike workload, written once against the [[OccModule]]
 * interface so it runs identically on the real opencascade.js module (gated
 * spike test) and on the [[FakeOcc]] double (always-on leak gate).
 *
 * It builds a square, extrudes it into a solid, drains the prism's
 * `Generated()` lineage lists, tessellates, and counts triangles. Every
 * transient OCC object passes through a `DisposeScope`; the produced solid is
 * handed to the `HandleTable` under an owner id, modelling a checkpoint-held
 * body whose lifetime the caller controls. Nothing is leaked: after the caller
 * releases the returned handle, both the scope and the table are empty.
 */

import { DisposeScope } from './disposeScope'
import { HandleTable, type OccHandle } from './handleTable'
import type { OccSpikeModule } from './occTypes'

export interface MeshResult {
  solidFaces: number
  triangles: number
  profileEdges: number
  // Total sub-shapes returned across every profile edge's Generated() list.
  generatedSubshapes: number
}

export interface ExtrudeOptions {
  side?: number
  height?: number
  // Owner id the produced solid is registered under (checkpoint/feature id).
  owner?: string
  linearDeflection?: number
}

interface ExtrudeOutput {
  result: MeshResult
  // Handle to the produced solid, owned by `table`. Release to evict.
  solid: OccHandle
}

export function extrudeSquareAndTessellate(
  oc: OccSpikeModule,
  table: HandleTable,
  opts: ExtrudeOptions = {},
): ExtrudeOutput {
  const side = opts.side ?? 10
  const height = opts.height ?? 5
  const owner = opts.owner ?? 'spike'
  const lin = opts.linearDeflection ?? 0.1
  const E = oc.TopAbs_ShapeEnum

  const scope = new DisposeScope()
  try {
    const poly = scope.track(new oc.BRepBuilderAPI_MakePolygon_1())
    poly.Add_1(scope.track(new oc.gp_Pnt_3(0, 0, 0)))
    poly.Add_1(scope.track(new oc.gp_Pnt_3(side, 0, 0)))
    poly.Add_1(scope.track(new oc.gp_Pnt_3(side, side, 0)))
    poly.Add_1(scope.track(new oc.gp_Pnt_3(0, side, 0)))
    poly.Close()

    const wire = scope.track(poly.Wire())
    const faceMaker = scope.track(new oc.BRepBuilderAPI_MakeFace_15(wire, false))
    const face = scope.track(faceMaker.Face())
    const vec = scope.track(new oc.gp_Vec_4(0, 0, height))
    const prism = scope.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true))

    // The solid is persisted, not transient: hand it to the table, do NOT track
    // it in the scope (the scope would delete it on dispose).
    const solid = prism.Shape()

    // Lineage sharp edge. Generated() returns a TopTools_ListOfShape; this OCC.js
    // build exposes no list iterator, so drain via Size/First_1/RemoveFirst.
    let profileEdges = 0
    let generatedSubshapes = 0
    const edgeExp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
    for (; edgeExp.More(); edgeExp.Next()) {
      profileEdges++
      const gen = scope.track(prism.Generated(edgeExp.Current()))
      while (gen.Size() > 0) {
        const sub = gen.First_1()
        generatedSubshapes++
        gen.RemoveFirst()
        sub.delete()  // proven-safe ordering against the real build (delete after RemoveFirst)
      }
    }

    scope.track(new oc.BRepMesh_IncrementalMesh_2(solid, lin, false, 0.5, false))

    let solidFaces = 0
    let triangles = 0
    const faceExp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
    for (; faceExp.More(); faceExp.Next()) {
      solidFaces++
      const f = scope.track(oc.TopoDS.Face_1(faceExp.Current()))
      const loc = scope.track(new oc.TopLoc_Location_1())
      const tri = scope.track(oc.BRep_Tool.Triangulation(f, loc))
      if (!tri.IsNull()) {
        const poly3 = tri.get()
        if (poly3) triangles += poly3.NbTriangles()
      }
    }

    const handle = table.register(solid, owner)
    return {
      result: { solidFaces, triangles, profileEdges, generatedSubshapes },
      solid: handle,
    }
  } finally {
    scope.dispose()
  }
}
