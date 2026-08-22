// STEP read/write adapter for the import_step leaf. Import writes
// the STEP bytes to the emscripten in-memory FS, reads them with
// STEPControl_Reader, and applies an optional uniform scale. Export writes a
// shape to the FS with STEPControl_Writer and reads the resulting bytes back.

import type { DisposeScope } from './disposeScope'
import type {
  OccModule, OccShape, OccSubShape, OccStepReader, OccTransformBuilder,
  OccDisposable, OccTransferBinder, OccMaybeShape, OccTransientHandle,
} from './occTypes'
import { makeScaleTrsf } from './transforms'
import { readShapeFaces, assembleMesh } from './tessellation'
import { SubShapeIndexMap } from './primitives'
import { faceGh } from './lineageHash'
import { encodeBinaryStl } from '../stl'

// A fixed short scratch path in the emscripten MEMFS. Two quirks of this OCC.js
// build forced both choices: STEPControl_Reader fails (RetError) on a long
// basename OR any path containing the substring "import", so the name is short
// and neutral. The kernel is single-threaded and each call writes -> reads ->
// unlinks synchronously, so reusing one path across calls is safe.
const SCRATCH_PATH = '/s.step'

// Various OCC.js return-status calls (ReadFile, Transfer, Write) may return a
// raw enum number or an embind enum object wrapping it in `.value`, depending
// on binding version. Unwrap either shape so callers can compare against a
// named enum member instead of a magic number.
const enumVal = (e: unknown): number => (typeof e === 'number' ? e : (e as { value: number }).value)

/** Decode a base64 string to bytes (portable across Node + browser/Worker). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A STEP read, plus the file-intrinsic identity of the faces it produced. */
export interface StepReadResult {
  shape: OccShape
  /**
   * `faceGh` (hashed exactly as a `TopExp_Explorer` walk over `shape` sees the
   * face) -> the STEP entity id the file wrote it under, i.e. the `17` of
   * `#17=ADVANCED_FACE(...)`. A face the transfer map does not cover is simply
   * absent; `importedNameMaps` names those from their neighbours instead.
   */
  faceStepIds: Record<string, number>
}

/**
 * Read STEP bytes into a shape, optionally scaled about the origin (mirrors
 * `step_file_to_shape`). The returned shape lives in `scope`; the caller owns it.
 *
 * Identity-free: `stepBytesToShapeWithIdentity` is the import path. This one is
 * for the export round-trips, which only want the geometry back.
 */
export function stepBytesToShape(
  oc: OccModule,
  scope: DisposeScope,
  bytes: Uint8Array,
  scale = 1.0,
): OccShape {
  return readStep(oc, scope, bytes, scale, false).shape
}

/**
 * Read STEP bytes into a shape AND recover each face's STEP entity id, the
 * ingredient imported faces are named by (`importedFacePath`). Without it every
 * face of an imported body collapses onto one query string and none of them is
 * individually selectable.
 */
export function stepBytesToShapeWithIdentity(
  oc: OccModule,
  scope: DisposeScope,
  bytes: Uint8Array,
  scale = 1.0,
): StepReadResult {
  return readStep(oc, scope, bytes, scale, true)
}

function readStep(
  oc: OccModule,
  scope: DisposeScope,
  bytes: Uint8Array,
  scale: number,
  withIdentity: boolean,
): StepReadResult {
  const path = SCRATCH_PATH
  oc.FS.writeFile(path, bytes)
  try {
    const reader = scope.track(new oc.STEPControl_Reader_1())
    const status = reader.ReadFile(path)
    const statusVal = enumVal(status)
    const doneVal = enumVal(oc.IFSelect_ReturnStatus.IFSelect_RetDone)
    if (statusVal !== doneVal) {
      throw new Error(`import_step: STEP read failed (status ${statusVal})`)
    }
    reader.TransferRoots()
    const read = reader.OneShape()
    // The scaled copy is a NEW shape the transfer map knows nothing about, so
    // the builder has to stay in hand to carry identity across it.
    const builder = scale !== 1.0
      ? transformBuilder(oc, scope, read, scale)
      : null
    const shape = builder ? builder.Shape() : read
    // The reader (and with it the transfer map) is tracked in `scope`, but the
    // caller's scope may outlive this call by a lot -- read the map now.
    const faceStepIds = withIdentity ? faceEntityIds(oc, scope, reader, read, shape, builder) : {}
    return { shape, faceStepIds }
  } finally {
    try {
      oc.FS.unlink(path)
    } catch {
      // best-effort cleanup
    }
  }
}

function transformBuilder(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  scale: number,
): OccTransformBuilder {
  const builder = scope.track(
    new oc.BRepBuilderAPI_Transform_2(shape, makeScaleTrsf(oc, scope, [0, 0, 0], scale), true),
  )
  builder.Build()
  return builder
}

/** Explorer-ordered faces of `shape`, as `TopoDS_Face`. */
function explodeFaces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Face_1(exp.Current())))
  return out
}

/**
 * Visit every `(face, STEP entity id)` the transfer produced, in ONE pass over
 * the transfer map.
 *
 * `XSControl_TransferReader.EntityFromShapeResult(face, -1)` answers the same
 * question per face, but it does so by scanning the whole map, so the import
 * became O(faces x map): +0.6 s at 300 faces, +11 s at 1200, +66 s at 3000.
 * Walking the map ourselves is O(map) -- +19 ms / +415 ms / +1141 ms for the
 * same three. The entries are parallel 1-based arrays: `Mapped(i)` is the
 * source entity, `MapItem(i)` the binder holding its result. Most binders hold
 * something that is not a shape (and shape binders hold solids and shells as
 * well as faces), hence the narrowing on `ShapeType`.
 *
 * A visitor rather than a returned array on purpose: the map runs to tens of
 * thousands of entries on a real import and every one of them costs three
 * embind proxies, which leak the WASM heap unless deleted. Handing the face to
 * a callback lets the whole entry be released before the next one is read, so
 * nothing accumulates. `visit` must not retain the face it is given.
 */
function forEachTransferredFace(
  oc: OccModule,
  reader: OccStepReader,
  visit: (face: OccShape, entityId: number) => void,
): void {
  const modelHandle = reader.Model()
  const wsHandle = reader.WS()
  const readerHandle = wsHandle.get().TransferReader()
  const processHandle = readerHandle.get().TransientProcess()
  const model = modelHandle.get()
  const process = processHandle.get()
  const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE
  try {
    const n = process.NbMapped()
    for (let i = 1; i <= n; i++) {
      const binderHandle = process.MapItem(i)
      let result: OccMaybeShape | undefined
      let entity: OccTransientHandle<unknown> | null = null
      try {
        if (binderHandle.IsNull()) continue
        // `.get()` is a borrowed view into the handle, NOT ours to delete --
        // freeing it takes the binder with it and the next map read faults with
        // "memory access out of bounds". Only the by-value returns are dropped.
        const binder: OccTransferBinder = binderHandle.get()
        result = binder.Result?.()
        if (!result?.ShapeType || !sameEnum(result.ShapeType(), faceType)) continue
        entity = process.Mapped(i)
        if (entity.IsNull()) continue
        visit(result as OccShape, model.IdentLabel(entity))
      } finally {
        drop(entity, result, binderHandle)
      }
    }
  } finally {
    drop(processHandle, readerHandle, wsHandle, modelHandle)
  }
}

/** Delete embind proxies in reverse acquisition order, tolerating nulls. */
function drop(...objects: (OccDisposable | null | undefined)[]): void {
  for (const obj of objects) obj?.delete()
}

/**
 * Compare two embind enum values. The binding hands them back as a raw number
 * in some places and as a `{value}` box in others (`ReadFile` above deals with
 * the same inconsistency), and `TopAbs_ShapeEnum` members are typed opaquely.
 */
function sameEnum(a: unknown, b: unknown): boolean {
  return enumVal(a) === enumVal(b)
}

/**
 * `faceGh -> STEP entity id` for the faces of `finalShape`.
 *
 * Two traps this navigates, both measured on `double_with_hole.step`:
 *
 * 1. The transfer map only knows the shapes the TRANSFER produced. On a
 *    `BRepBuilderAPI_Transform` copy (the `scale != 1` path) none of its faces
 *    appear in it at all, so the lookup runs on the pre-transform faces and the
 *    result is carried over with `ModifiedShape`.
 * 2. The map may NOT be keyed on `faceGh` of a face taken from anywhere but the
 *    explorer walk. `ModifiedShape` hands a face back with its own orientation,
 *    `faceGh` folds in the normal, and for 3 of those 7 faces that hash differs
 *    from the explorer's. Every consumer (`classifyFace`, `namesForSolid`,
 *    `_registerBrepFaceAncestry`) looks names up by the EXPLORER's hash, so
 *    keying it the other way silently loses ~40% of the faces with no error
 *    anywhere. `SubShapeIndexMap` pairs by topological identity instead, which
 *    is orientation-insensitive and O(1) per face.
 */
function faceEntityIds(
  oc: OccModule,
  scope: DisposeScope,
  reader: OccStepReader,
  readShape: OccShape,
  finalShape: OccShape,
  builder: OccTransformBuilder | null,
): Record<string, number> {
  const unplaced = unplacer(oc, scope)
  const finalFaces = explodeFaces(oc, scope, finalShape)
  // The transfer only knows the shape it read, which IS the final one unless a
  // scale copied it.
  const sourceFaces = builder ? explodeFaces(oc, scope, readShape) : finalFaces
  const sourceIndex = new UnplacedFaceIndex()
  sourceFaces.forEach((face, i) => sourceIndex.add(unplaced.keep(face), i))

  // source position -> the final face it became, paired ONCE. Doing this inside
  // the entity loop instead would put the quadratic straight back.
  const targets = builder ? pairAcrossTransform(oc, scope, sourceFaces, finalFaces, builder) : finalFaces

  const out: Record<string, number> = {}
  let transferred = 0
  forEachTransferredFace(oc, reader, (face, entityId) => {
    transferred++
    // Resolved to positions immediately, and the borrowed copy released with
    // the face itself, so nothing but the integers survives the walk.
    const positions = unplaced.borrow(face, (bare) => sourceIndex.at(bare))
    for (const at of positions) {
      const target = targets[at]
      if (!target) continue
      const gh = faceGh(oc, scope, target)
      // First writer wins, so the result cannot depend on binder order should
      // two entities ever resolve to one face.
      if (!(gh in out)) out[gh] = entityId
    }
  })

  // A total miss is the failure mode this whole path exists to prevent, and it
  // is silent by nature: the import still builds, every face just shares one
  // query again. It has already happened once (the multi-root placement bug
  // below), so it fails loudly rather than degrading.
  if (transferred > 0 && Object.keys(out).length === 0) {
    throw new Error(
      `import_step: the STEP transfer named ${transferred} faces but none of them ` +
      `matched the ${finalFaces.length} faces of the imported shape`,
    )
  }
  return out
}

/**
 * Unplaced face -> every position it occupies.
 *
 * A plain `SubShapeIndexMap` keeps only the first position per identity, which
 * would leave a repeated assembly instance (the same part placed twice, hence
 * the same TShape and the same STEP face entity) entirely unnamed past the
 * first copy. Every instance gets the entity id instead; they stay pickable
 * apart because the per-solid index (importLineage.ts) folds the bodySplit
 * solid order into the UUID path, so each copy's faces carry disjoint `@u|`
 * tokens.
 */
class UnplacedFaceIndex {
  private readonly canonical = new SubShapeIndexMap()
  private readonly positions = new Map<number, number[]>()

  add(face: OccSubShape, position: number): void {
    const at = this.canonical.get(face)
    if (at < 0) {
      this.canonical.set(face, position)
      this.positions.set(position, [position])
      return
    }
    this.positions.get(at)?.push(position)
  }

  // Every position sharing this face's identity, or empty when unknown.
  at(face: OccSubShape): number[] {
    const canonical = this.canonical.get(face)
    return canonical < 0 ? [] : (this.positions.get(canonical) ?? [])
  }
}

/**
 * Strip a shape's placement, so `IsSame` and `HashCode` compare TShapes alone.
 *
 * Needed because a STEP file with several roots comes back with each root under
 * its own `TopLoc_Location`, and the transfer binders hold the UNPLACED faces:
 * across a two-solid file, binder face vs explorer face is `IsPartner` for all
 * 12 and `IsSame` for none, so a plain `SubShapeIndexMap` silently matched
 * nothing and the whole import went unnamed. Both sides are normalised here.
 *
 * Two placements of ONE part (a repeated assembly instance) therefore collapse
 * to the same key. That is handled, not tolerated: `UnplacedFaceIndex` hands
 * the entity id to every instance, and the per-solid index folded into the UUID
 * path keeps their queries apart.
 *
 * `keep` copies live in `scope` because the index holds them; `borrow` is for a
 * lookup that ends inside the callback, and releases immediately.
 */
function unplacer(oc: OccModule, scope: DisposeScope): {
  keep: (shape: OccShape) => OccSubShape
  borrow: <T>(shape: OccShape, read: (bare: OccSubShape) => T) => T
} {
  const identity = scope.track(new oc.TopLoc_Location_1())
  const strip = (shape: OccShape): OccSubShape => (shape as OccSubShape).Located(identity) as OccSubShape
  return {
    keep: (shape) => scope.track(strip(shape)),
    borrow: (shape, read) => {
      const bare = strip(shape)
      try {
        return read(bare)
      } finally {
        bare.delete()
      }
    },
  }
}

/** `sourceFaces[i]` -> the face of the transformed shape it became, or null. */
function pairAcrossTransform(
  oc: OccModule,
  scope: DisposeScope,
  sourceFaces: OccShape[],
  finalFaces: OccShape[],
  builder: OccTransformBuilder,
): (OccShape | null)[] {
  const unplaced = unplacer(oc, scope)
  const finalIndex = new SubShapeIndexMap()
  finalFaces.forEach((face, i) => finalIndex.set(unplaced.keep(face), i))
  return sourceFaces.map((face) => {
    const moved = scope.track(oc.TopoDS.Face_1(builder.ModifiedShape(face)))
    const at = unplaced.borrow(moved, (bare) => finalIndex.get(bare))
    return at >= 0 ? finalFaces[at] : null
  })
}

/**
 * Serialise a shape to STEP bytes (mirrors Python `_serialise_step`).
 * Uses the emscripten MEMFS: writes to a scratch path, then reads it back.
 * The caller owns the scope; the returned bytes are a standalone copy.
 */
export function stepShapeToBytes(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): Uint8Array {
  const path = SCRATCH_PATH
  const writer = scope.track(new oc.STEPControl_Writer_1())
  const wStatus = writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true)
  const doneVal = enumVal(oc.IFSelect_ReturnStatus.IFSelect_RetDone)
  if (enumVal(wStatus) !== doneVal) {
    throw new Error('STEP export: Transfer failed')
  }
  const wrote = writer.Write(path)
  if (enumVal(wrote) !== doneVal) {
    throw new Error('STEP export: Write failed')
  }
  const text = oc.FS.readFile(path, { encoding: 'utf8' })
  try {
    oc.FS.unlink(path)
  } catch {
    // best-effort cleanup
  }
  const enc = new TextEncoder()
  return enc.encode(text)
}

/**
 * Serialise a shape to binary STL bytes directly from its tessellation.
 *
 * This avoids StlAPI_Writer which does not integrate with the emscripten
 * MEMFS in this OCC.js build.
 */
export function shapeToStlBytes(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  deflection = 0.1,
  angularDeflection = 0.1,
): Uint8Array {
  scope.track(new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, angularDeflection, false))
  const raw = readShapeFaces(oc, scope, shape, deflection, angularDeflection)
  const mesh = assembleMesh(raw)

  const vertices = new Float32Array(mesh.vertices.length * 3)
  for (let i = 0; i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i]
    vertices[i * 3] = v[0]; vertices[i * 3 + 1] = v[1]; vertices[i * 3 + 2] = v[2]
  }
  const indices = new Uint32Array(mesh.faces.length * 3)
  for (let i = 0; i < mesh.faces.length; i++) {
    const f = mesh.faces[i]
    indices[i * 3] = f[0]; indices[i * 3 + 1] = f[1]; indices[i * 3 + 2] = f[2]
  }
  return encodeBinaryStl([{ vertices, indices }])
}
