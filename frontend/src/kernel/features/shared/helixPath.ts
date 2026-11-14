// Which sweep features follow a helix, read from the same repository descriptor
// the sweep leaf consumes. A boolean feature is handed whole bodies, not the
// feature that made the tool, so the only way to recognise a thread at boolean
// time is to resolve the body's creating sweep and ask its path. Keeping this
// beside the path reader means the guard and the sweep cannot disagree about
// whether a ref names a helix.

import { featureRefId, type Repository } from '../../query'
import { descriptorFromRepo } from '../helix'

type Vec3 = [number, number, number]

/** The helix axis line a sweep's path follows. */
export interface HelixAxis {
  origin: Vec3
  axis: Vec3
}

interface SweepShape {
  kind?: unknown
  // The canonical sub-def; a legacy flat feature carries `path` at the top.
  sweep?: unknown
  path?: unknown
}

/** The path refs of a sweep def, from its sub-def or the legacy flat field. */
function pathRefsOf(def: SweepShape): unknown[] {
  const nested = def.sweep
  const sub = typeof nested === 'object' && nested !== null
    ? (nested as { path?: unknown })
    : null
  const refs = sub?.path !== undefined ? sub.path : def.path
  return Array.isArray(refs) ? refs : [refs]
}

/**
 * The helix axis of `def` when it is a sweep whose path is a helix. A helix
 * path stands alone in v1, so the first resolved ref is the whole answer.
 */
export function helixAxisOfSweepDef(def: unknown, globalRepo: Repository): HelixAxis | null {
  if (typeof def !== 'object' || def === null) return null
  const sweep = def as SweepShape
  if (sweep.kind !== 'sweep') return null
  for (const ref of pathRefsOf(sweep)) {
    if (typeof ref !== 'string') continue
    const id = featureRefId(ref)
    if (id === null) continue
    const desc = descriptorFromRepo(globalRepo, id)
    if (desc !== null) return { origin: desc.origin, axis: desc.axis }
  }
  return null
}
