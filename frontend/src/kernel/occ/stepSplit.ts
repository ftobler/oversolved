// Split one STEP file into one STEP file per solid, at import time.
//
// This is the kernel half of the B2 import mode. The file is parsed exactly
// once, its solids are ordered by the same `splitSolids` rule a multi-solid part
// import uses (so the per-solid index here and the body order there agree), and
// each solid is serialised on its own. The parts then import those small files
// through the ordinary import_step leaf: nothing downstream knows a file was
// ever bigger than one solid.
//
// The solid keeps its world coordinates, so re-reading the split file places it
// exactly where it sat in the source. The assembly places every instance at the
// identity transform and reproduces the original file.
//
// A solid the split drops as debris (the zero-volume skin a boolean can leave)
// is not a leftover: it carries no material on purpose. `leftovers` counts the
// shells and faces the file held outside every solid, which are what a
// surfaces-only STEP has instead of solids.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { stepBytesToShape, stepShapeToBytes } from './stepIo'
import { volumeOf } from './booleans'
import { splitSolids } from '../features/partSplit'

/** One solid of the source file, written as its own STEP bytes. */
export interface StepSplitSolid {
  bytes: Uint8Array
  // The solid's volume in the file's units, so a caller can report what landed
  // without re-reading the bytes.
  volume: number
}

export interface StepSplitResult {
  // In splitSolids order: the order a multi-solid import's bodies are minted.
  solids: StepSplitSolid[]
  // Shells and faces outside every solid (a surfaces-only file reports 0 solids
  // and its leftovers here).
  leftovers: number
}

/**
 * Parse `bytes` and write each solid out as its own STEP file. `scale` mirrors
 * the import_step feature's uniform scale, so a scaled import's split solids
 * land at the same size.
 */
export function splitStepSolids(
  oc: OccModule,
  scope: DisposeScope,
  bytes: Uint8Array,
  scale = 1.0,
): StepSplitResult {
  const shape = scope.track(stepBytesToShape(oc, scope, bytes, scale))
  const solids = splitSolids(oc, scope, shape).map(solid => ({
    bytes: stepShapeToBytes(oc, scope, solid),
    volume: Math.abs(volumeOf(oc, scope, solid)),
  }))
  return { solids, leftovers: countLeftovers(oc, scope, shape) }
}

// Shells that hold no solid, plus faces that belong to no shell at all. Two
// walks rather than a full face census: the explorer's ToAvoid argument keeps
// each walk out of the shapes the other counts, so nothing is counted twice.
function countLeftovers(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const E = oc.TopAbs_ShapeEnum
  return countAvoiding(oc, scope, shape, E.TopAbs_SHELL, E.TopAbs_SOLID)
    + countAvoiding(oc, scope, shape, E.TopAbs_FACE, E.TopAbs_SHELL)
}

function countAvoiding(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  find: object,
  avoid: object,
): number {
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, find, avoid))
  let count = 0
  for (; exp.More(); exp.Next()) count++
  return count
}
