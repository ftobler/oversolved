// The state a build leaves when it stops between two features (`buildAbortable`
// in builder.ts): a valid prevState for the next build, holding only checkpoints
// that are complete. `findFirstDirty` treats the first missing checkpoint as
// dirty, so the next build resumes exactly where this one stopped.

import type { BuildState, FeatureCheckpoint } from './types3d'
import { partsNeedingCheckpointRegistration } from './builderAncestry'
import { boundCheckpointMeshes } from './builderMeshReuse'

export interface PartialBuild {
  state: BuildState
  /** Features this build solved whose checkpoints the partial state does not
   *  keep. Their `cp:<fid>` retains and base registrations are the caller's to
   *  release; nothing in the state refers to them. */
  dropped: string[]
}

export interface PartialBuildInput {
  // The full feature order of the document (the state's `feature_order`).
  featureOrder: readonly string[]
  // Ids of the features the build iterates (the rollback slice).
  fids: readonly string[]
  // Index of the first feature this build solved; earlier ones are carried.
  firstDirty: number
  // Index of the last feature whose checkpoint was stored.
  builtThrough: number
  checkpoints: Readonly<Record<string, FeatureCheckpoint>>
  // Per solved checkpoint, the registered body versions when it was taken.
  registeredAtCheckpoint: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** The post-loop ancestry registration for one solved checkpoint whose
   *  `needing` bodies the loop did not register (`finishBuild` runs the same
   *  pass). Returns the completed checkpoint. */
  complete: (cp: FeatureCheckpoint, needing: ReadonlySet<string>) => FeatureCheckpoint
}

/**
 * Keep the checkpoints `0..builtThrough`. A solved checkpoint whose bodies still
 * need the post-loop ancestry registration gets it here (`complete`), since the
 * stop skips `finishBuild`; usually no body needs it. The keep is truncated
 * before the first solved feature whose id repeats among the solved ones:
 * checkpoints are keyed by id, so the later copy overwrote the earlier one's
 * entry, and the caller releases dropped ids by owner, which must never reach a
 * kept checkpoint's shapes.
 *
 * The carried clean prefix is always complete. Meshes are bounded the way a
 * finished build bounds them, with the last kept checkpoint as the final one: a
 * carried previous final keeps its mesh and provenance marker only while nothing
 * solved after it is kept, since `finalCheckpointOf` would otherwise serve its
 * meshes for bodies a later kept checkpoint changed.
 */
export function partialBuildState(input: PartialBuildInput): PartialBuild {
  const { featureOrder, fids, firstDirty, builtThrough, checkpoints, registeredAtCheckpoint, complete } = input
  const solvedCount = new Map<string, number>()
  for (let i = firstDirty; i <= builtThrough; i++) solvedCount.set(fids[i], (solvedCount.get(fids[i]) ?? 0) + 1)

  const kept: Record<string, FeatureCheckpoint> = {}
  const dropped = new Set<string>()
  let lastKept: string | null = null
  let truncated = false
  for (let i = 0; i <= builtThrough; i++) {
    const fid = fids[i]
    const cp = checkpoints[fid]
    if (!truncated && i >= firstDirty) truncated = !cp || (solvedCount.get(fid) ?? 0) > 1
    if (truncated || !cp) {
      if (i >= firstDirty) dropped.add(fid)
      continue
    }
    if (i < firstDirty) {
      kept[fid] = cp
    } else {
      const needing = partsNeedingCheckpointRegistration(
        cp.body_store_snapshot,
        registeredAtCheckpoint.get(fid) ?? new Map(),
      )
      kept[fid] = needing.size ? complete(cp, needing) : cp
    }
    lastKept = fid
  }
  boundCheckpointMeshes(kept, lastKept, null)
  return {
    state: { feature_order: [...featureOrder], checkpoints: kept },
    dropped: [...dropped],
  }
}
