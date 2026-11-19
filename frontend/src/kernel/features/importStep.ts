// Reads STEP bytes (optionally scaled) into a shape and registers a body per
// solid found in it. The bytes arrive in the solve file map, keyed by the
// feature's `file_id`; the STEP parse itself lives in occ/stepIo.ts.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { SubShapeMap } from '../occ/subshapeIdentity'
import { canonicalFaces } from '../occ/partNames'
import { faceArea } from '../occ/primitives'
import {
  bodyImportColor, hexOfPackedRgb, importColorNoteText, type FaceColorSample,
} from '../occ/importColor'
import type { HandleTable } from '../occ/handleTable'
import type { PartSolid } from '../types3d'
import type { Repository } from '../query'
import { stepBytesToShapeWithIdentity } from '../occ/stepIo'
import { importedNameMaps } from '../occ/importLineage'
import { registerSplitParts, splitSolids } from './partSplit'
import { timePhase } from '../occ/phaseTimer'

type Dict = Record<string, unknown>

interface ImportStepResult {
  [key: string]: unknown
  status: string
  // The first body, kept for callers that want a single handle on the import.
  body_id: string
  body_ids: string[]
}

/** Solve an import_step feature (mirrors `_solve_import_step`). */
export function solveImportStep(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  files?: ReadonlyMap<string, Uint8Array>,
): ImportStepResult {
  const featureId = (feature.id as string) ?? ''
  const fileId = (feature.file_id as string) ?? ''
  const scale = Number(feature.scale ?? 1.0)
  // A non-finite or non-positive scale would flow unchecked into the placement
  // identity computation: 0 reaches gp_Trsf.SetScale, whose inverse divides by
  // the factor, and a negative factor is a central inversion the import UI
  // never offers. Both are refused by name here.
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`import_step: scale must be a positive finite number, got ${feature.scale}`)
  }

  // A pre-cut document carries the bytes inline. Refuse it by name rather than
  // solving an empty import; there is no migration (A2). This must precede the
  // file_id check: such a document has file_data and no file_id, so the
  // requires-file_id diagnostic would blame the wrong thing.
  if (typeof feature.file_data === 'string' && feature.file_data.length > 0) {
    throw new Error("import_step: inline 'file_data' is no longer supported; re-import the STEP file "
      + `(file_id: ${fileId || 'none'})`)
  }
  if (!fileId) throw new Error("import_step: requires 'file_id'")

  const bytes = files?.get(fileId)
  if (!bytes) throw new Error(`import_step: file '${fileId}' is not present in the solve file set`)

  const partId = 'body_' + featureId
  const { shape: read, faceStepIds, faceColors, solidColors, colorWarning } =
    stepBytesToShapeWithIdentity(oc, scope, bytes, scale)
  const shape = scope.track(read)
  // The same sibling order `registerSplitParts` mints body ids in.
  const solids = splitSolids(oc, scope, shape)

  // Named from the STEP file's own entity ids. Without this every face of the
  // import shares one query string (`@<feature>@<body>`) and none of them is
  // individually selectable -- see occ/importLineage.ts. Computed on the whole
  // shape; `registerSplitParts` narrows the maps per sibling. A repeated
  // instance (one part placed twice) shares its entity ids, so the per-solid
  // index from `splitSolids` -- the same order body ids are minted with -- is
  // folded into the UUID path to keep the copies' `@u|` tokens disjoint.
  const names = timePhase('import.names', () =>
    importedNameMaps(oc, scope, shape, faceStepIds, featureId, solids))

  // A STEP file holding several parts arrives as one compound, so the import is
  // exactly the "a shape becomes bodies" case partSplit owns: one body per
  // solid, or one body carrying the whole shape when the file has no solid at
  // all (surfaces/shells only).
  const partIds = timePhase('import.split', () => registerSplitParts(oc, scope, table, partStore, shape, {
    id: partId,
    createdBy: featureId,
    imported: true,
    faceNames: names.faceNames,
    edgeNames: names.edgeNames,
    faceAncestry: names.faceAncestry,
    edgeAncestry: names.edgeAncestry,
  }))
  const notes = timePhase('import.colors', () =>
    applyImportColors(oc, scope, solids.length > 0 ? solids : [shape], partIds, faceColors, solidColors, partStore))
  return {
    status: 'ok',
    body_id: partIds[0],
    body_ids: partIds,
    // Not a problem: the import built what the file holds. The note says which
    // colour a body took when its faces disagreed, so the pick is not silent.
    ...(notes.length > 0 ? { solver_note: notes.join('; ') } : {}),
    // The geometry imported but its colours could not be paired with it, so
    // every body took the palette: worth a warning, never a failed import.
    ...(colorWarning !== undefined ? { solver_warning: colorWarning } : {}),
  }
}

/**
 * Stamp each new body with the colour its file gives it (occ/importColor.ts)
 * and return the notes for the bodies whose faces disagreed. `parts[i]` is the
 * solid `ids[i]` was minted from. Face areas are read only for a body whose
 * faces carry more than one colour: in the common case (one colour, or none)
 * there is nothing to weigh.
 */
function applyImportColors(
  oc: OccModule,
  scope: DisposeScope,
  parts: OccShape[],
  ids: string[],
  faceColors: SubShapeMap<number>,
  solidColors: SubShapeMap<number>,
  partStore: Record<string, PartSolid>,
): string[] {
  const notes: string[] = []
  if (faceColors.size === 0 && solidColors.size === 0) return notes
  parts.forEach((part, i) => {
    const body = partStore[ids[i]]
    if (!body) return
    const faces = canonicalFaces(oc, scope, part)
    const colors = faces.map((face) => {
      const packed = faceColors.get(face)
      return packed === undefined ? null : hexOfPackedRgb(packed)
    })
    const uniform = colors.every((c) => c === colors[0])
    const samples: FaceColorSample[] = colors.map((color, at) => ({
      color,
      area: uniform ? 1 : faceArea(oc, scope, faces[at] as OccShape),
    }))
    const solidPacked = solidColors.get(part as OccSubShape)
    const chosen = bodyImportColor(samples, solidPacked === undefined ? null : hexOfPackedRgb(solidPacked))
    if (chosen === null) return
    if (chosen.color !== null) body.import_color = chosen.color
    if (chosen.note) notes.push(importColorNoteText(ids[i], chosen.note))
  })
  return notes
}
