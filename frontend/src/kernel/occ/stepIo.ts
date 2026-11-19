// STEP read/write adapter for the import_step leaf. Import writes
// the STEP bytes to the emscripten in-memory FS, reads them with the
// colour-aware OversolvedStepCaf (STEPControl_Reader for the identity-free
// round trips), and applies an optional uniform scale. Export writes a
// shape to the FS with STEPControl_Writer and reads the resulting bytes back.

import type { DisposeScope } from './disposeScope'
import type {
  OccModule, OccShape, OccSubShape, OccStepReader, OccTransformBuilder,
  OccDisposable, OccTransferBinder, OccMaybeShape, OccTransientHandle,
  OccStepCafColors, OccShapeEnumValue,
} from './occTypes'
import { makeScaleTrsf } from './transforms'
import { readShapeFaces, assembleMesh } from './tessellation'
import { SubShapeIndexMap, unplacer } from './primitives'
import { SubShapeMap } from './subshapeIdentity'
import { enumVal, sameEnum } from './enumValue'
import { encodeBinaryStl } from '../stl'
import { noProgress } from './defaultArgs'
import { timePhase } from './phaseTimer'

// A fixed short scratch path in the emscripten MEMFS. Two quirks of the 7.4
// build forced both choices: STEPControl_Reader failed
// (RetError) on a long basename OR any path containing the substring "import",
// so the name is short and neutral. The kernel is single-threaded and each call writes -> reads ->
// unlinks synchronously, so reusing one path across calls is safe.
const SCRATCH_PATH = '/s.step'

/**
 * Decode a base64 string to bytes (portable across Node + browser/Worker).
 * The buffer is stated as a plain ArrayBuffer, not ArrayBufferLike, so the
 * result is accepted by APIs that refuse a possibly-shared buffer (the File
 * System Access writable stream, for one).
 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A STEP read, plus the file-intrinsic identity of the faces it produced. */
export interface StepReadResult {
  shape: OccShape
  /**
   * A face of `shape` -> the STEP entity id the file wrote it under, i.e. the
   * `17` of `#17=ADVANCED_FACE(...)`. A face the transfer map does not cover
   * is simply absent; `importedNameMaps` names those from their neighbours
   * instead.
   */
  faceStepIds: SubShapeMap<number>
  /**
   * A face of `shape` -> its effective file colour (`0xRRGGBB`, sRGB): its own,
   * else the nearest owner's. A face the file leaves uncoloured is absent, so
   * an uncoloured file yields an empty map.
   */
  faceColors: SubShapeMap<number>
  // A solid of `shape` -> the colour the file put on the solid itself.
  solidColors: SubShapeMap<number>
}

/**
 * Which reader drives an identity read. `caf` (OversolvedStepCaf) is the import
 * path: it reads colours from the same transfer the identity comes from.
 * `plain` (STEPControl_Reader) is the reference the identity guard compares it
 * against, face for face (`stepCafIdentityReal.test.ts`).
 */
export type StepReaderKind = 'caf' | 'plain'

// What the transfer-map walk needs of either reader.
type TransferSource = Pick<OccStepReader, 'Model' | 'WS'>

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
  return readStep(oc, scope, bytes, scale, false, 'plain').shape
}

/**
 * Read STEP bytes into a shape AND recover each face's STEP entity id, the
 * ingredient imported faces are named by (`importedFacePath`). Without it every
 * face of an imported body collapses onto one query string and none of them is
 * individually selectable. The colours come from the same transfer.
 */
export function stepBytesToShapeWithIdentity(
  oc: OccModule,
  scope: DisposeScope,
  bytes: Uint8Array,
  scale = 1.0,
  reader: StepReaderKind = 'caf',
): StepReadResult {
  return readStep(oc, scope, bytes, scale, true, reader)
}

// A read reader after its transfer: the shape, and the colours when it has any.
interface Transferred {
  source: TransferSource
  read: OccShape
  colors: OccStepCafColors | null
}

function transfer(oc: OccModule, scope: DisposeScope, path: string, kind: StepReaderKind): Transferred {
  const doneVal = enumVal(oc.IFSelect_ReturnStatus.IFSelect_RetDone)
  const refuseStatus = (status: unknown): void => {
    const statusVal = enumVal(status)
    if (statusVal !== doneVal) throw new Error(`import_step: STEP read failed (status ${statusVal})`)
  }
  if (kind === 'plain') {
    const reader = scope.track(new oc.STEPControl_Reader_1())
    refuseStatus(timePhase('step.read', () => reader.ReadFile_1(path)))
    timePhase('step.transfer', () => reader.TransferRoots(noProgress(oc)))
    return { source: reader, read: reader.OneShape(), colors: null }
  }
  const reader = scope.track(new oc.OversolvedStepCaf())
  refuseStatus(timePhase('step.read', () => reader.ReadFile(path)))
  if (!timePhase('step.transfer', () => reader.Transfer())) {
    throw new Error('import_step: STEP transfer failed')
  }
  const read = reader.OneShape()
  return { source: reader, read, colors: timePhase('step.colors', () => reader.Colors(read)) }
}

function readStep(
  oc: OccModule,
  scope: DisposeScope,
  bytes: Uint8Array,
  scale: number,
  withIdentity: boolean,
  kind: StepReaderKind,
): StepReadResult {
  const path = SCRATCH_PATH
  oc.FS.writeFile(path, bytes)
  try {
    const { source: reader, read, colors } = transfer(oc, scope, path, kind)
    // The scaled copy is a NEW shape the transfer map knows nothing about, so
    // the builder has to stay in hand to carry identity across it.
    const builder = scale !== 1.0
      ? transformBuilder(oc, scope, read, scale)
      : null
    // On the scaled path the OneShape() result becomes an intermediate only
    // the identity map reads; track it so the copy does not strand it on the
    // heap (unscaled, it IS the returned shape and stays untracked).
    if (builder !== null) scope.track(read)
    const shape = builder ? builder.Shape() : read
    if (!withIdentity) {
      return { shape, faceStepIds: new SubShapeMap(), faceColors: new SubShapeMap(), solidColors: new SubShapeMap() }
    }
    // The reader (and with it the transfer map) is tracked in `scope`, but the
    // caller's scope may outlive this call by a lot -- read the map now.
    const faces = pairReadFaces(oc, scope, read, shape, builder)
    const faceStepIds = timePhase('step.identity', () => faceEntityIds(oc, scope, reader, faces))
    const { faceColors, solidColors } = colorMaps(oc, scope, colors, faces, read, shape, builder)
    return { shape, faceStepIds, faceColors, solidColors }
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
    new oc.BRepBuilderAPI_Transform_2(shape, makeScaleTrsf(oc, scope, [0, 0, 0], scale), true, false),
  )
  builder.Build(noProgress(oc))
  return builder
}

type Cast = (shape: OccShape) => OccShape

/** Explorer-ordered faces of `shape`, as `TopoDS_Face`. */
function explodeFaces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return explode(oc, scope, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, (s) => oc.TopoDS.Face_1(s))
}

/** Explorer-ordered solids of `shape`, as `TopoDS_Solid`. */
function explodeSolids(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return explode(oc, scope, shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, (s) => oc.TopoDS.Solid_1(s))
}

function explode(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  kind: OccShapeEnumValue,
  cast: Cast,
): OccShape[] {
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, kind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(cast(exp.Current())))
  return out
}

/**
 * The read shape's faces in explorer order (`sourceFaces`, the order the
 * transfer map and `Colors` speak), the final shape's (`finalFaces`), and
 * `targets[i]`, the final face `sourceFaces[i]` became, paired ONCE. Doing the
 * pairing inside the entity loop instead would put the quadratic straight back.
 * Without a scale copy the two lists are one.
 */
interface ReadFaces {
  sourceFaces: OccShape[]
  finalFaces: OccShape[]
  targets: (OccShape | null)[]
}

function pairReadFaces(
  oc: OccModule,
  scope: DisposeScope,
  readShape: OccShape,
  finalShape: OccShape,
  builder: OccTransformBuilder | null,
): ReadFaces {
  const finalFaces = explodeFaces(oc, scope, finalShape)
  if (!builder) return { sourceFaces: finalFaces, finalFaces, targets: finalFaces }
  const sourceFaces = explodeFaces(oc, scope, readShape)
  const targets = pairAcrossTransform(oc, scope, sourceFaces, finalFaces, builder, (s) => oc.TopoDS.Face_1(s))
  return { sourceFaces, finalFaces, targets }
}

/**
 * `Colors`' explorer-ordered arrays keyed by the final shape's own faces and
 * solids, -1 (no colour) left out. A plain read has no colours at all.
 */
function colorMaps(
  oc: OccModule,
  scope: DisposeScope,
  colors: OccStepCafColors | null,
  faces: ReadFaces,
  readShape: OccShape,
  finalShape: OccShape,
  builder: OccTransformBuilder | null,
): { faceColors: SubShapeMap<number>, solidColors: SubShapeMap<number> } {
  const faceColors = new SubShapeMap<number>()
  const solidColors = new SubShapeMap<number>()
  if (colors === null) return { faceColors, solidColors }
  const keyed = (out: SubShapeMap<number>, values: Int32Array, targets: (OccShape | null)[]): void => {
    // A count mismatch means the helper walked another shape than ours: refuse
    // rather than pair colours with the wrong faces.
    if (values.length !== targets.length) {
      throw new Error(`import_step: ${values.length} colours read for ${targets.length} sub-shapes`)
    }
    targets.forEach((target, i) => {
      if (target !== null && values[i] >= 0) out.set(target as OccSubShape, values[i])
    })
  }
  keyed(faceColors, colors.faceColor, faces.targets)
  if (colors.solidColor.some((c) => c >= 0)) {
    const finalSolids = explodeSolids(oc, scope, finalShape)
    const solidTargets = builder
      ? pairAcrossTransform(oc, scope, explodeSolids(oc, scope, readShape), finalSolids, builder,
        (s) => oc.TopoDS.Solid_1(s))
      : finalSolids
    keyed(solidColors, colors.solidColor, solidTargets)
  }
  return { faceColors, solidColors }
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
  reader: TransferSource,
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
 * The faces of `finalShape` (as its explorer walk yields them) -> the STEP
 * entity id each was transferred from.
 *
 * Two traps this navigates, both measured on `double_with_hole.step`:
 *
 * 1. The transfer map only knows the shapes the TRANSFER produced. On a
 *    `BRepBuilderAPI_Transform` copy (the `scale != 1` path) none of its faces
 *    appear in it at all, so the lookup runs on the pre-transform faces and the
 *    result is carried over with `ModifiedShape`.
 * 2. `ModifiedShape` hands a face back with its own orientation, so the
 *    pairing to the final faces goes by topological identity
 *    (`SubShapeIndexMap`), which is orientation-insensitive and O(1) per face,
 *    and the map is keyed by the final shape's own explorer faces.
 */
function faceEntityIds(
  oc: OccModule,
  scope: DisposeScope,
  reader: TransferSource,
  faces: ReadFaces,
): SubShapeMap<number> {
  const { sourceFaces, finalFaces, targets } = faces
  const unplaced = unplacer(oc, scope)
  const sourceIndex = new UnplacedFaceIndex()
  sourceFaces.forEach((face, i) => sourceIndex.add(unplaced.keep(face), i))

  const out = new SubShapeMap<number>()
  let transferred = 0
  forEachTransferredFace(oc, reader, (face, entityId) => {
    transferred++
    // Resolved to positions immediately, and the borrowed copy released with
    // the face itself, so nothing but the integers survives the walk.
    const positions = unplaced.borrow(face, (bare) => sourceIndex.at(bare))
    for (const at of positions) {
      const target = targets[at]
      if (!target) continue
      // First writer wins, so the result cannot depend on binder order should
      // two entities ever resolve to one face.
      if (!out.has(target as OccSubShape)) out.set(target as OccSubShape, entityId)
    }
  })

  // A total miss is the failure mode this whole path exists to prevent, and it
  // is silent by nature: the import still builds, every face just shares one
  // query again. It has already happened once (the multi-root placement bug
  // below), so it fails loudly rather than degrading.
  if (transferred > 0 && out.size === 0) {
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
 * apart because the per-solid index (importLineage.ts) folds the partSplit
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

/** `sourceFaces[i]` -> the sub-shape of the transformed shape it became, or
 *  null. Faces or solids alike; `cast` restores the type ModifiedShape drops. */
function pairAcrossTransform(
  oc: OccModule,
  scope: DisposeScope,
  sourceFaces: OccShape[],
  finalFaces: OccShape[],
  builder: OccTransformBuilder,
  cast: Cast,
): (OccShape | null)[] {
  const unplaced = unplacer(oc, scope)
  const finalIndex = new SubShapeIndexMap()
  finalFaces.forEach((face, i) => finalIndex.set(unplaced.keep(face), i))
  return sourceFaces.map((face) => {
    const moved = scope.track(cast(builder.ModifiedShape(face)))
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
  const wStatus = writer.Transfer_1(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, noProgress(oc))
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
 * This avoids StlAPI_Writer, which did not integrate with the emscripten MEMFS
 * in the 7.4 build, and keeps the STL facets identical to the
 * viewport mesh.
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
