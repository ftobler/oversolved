/**
 * The values OCCT declares as default arguments, for the calls that need them.
 *
 * Embind binds no default arguments: a member is bound with its full parameter
 * list, and calling it with fewer is a BindingError. So every `Build()`,
 * `Perform()`, `TransferRoots()` and the like that OCCT declares with a trailing
 * `const Message_ProgressRange& = Message_ProgressRange()` takes one explicitly,
 * and the few other defaulted trailing parameters the kernel reaches are named
 * here once with OCCT's own default.
 */

import type { OccDisposable } from './occTypes'

interface ProgressRangeModule {
  Message_ProgressRange_1: new () => OccDisposable
}

const ranges = new WeakMap<object, OccDisposable>()

/**
 * The null `Message_ProgressRange` for `oc`. A default-constructed range has no
 * indicator behind it, so the scope an algorithm opens on it is inert, and the
 * "range already used" check that would object to reuse is a debug-only
 * assert. One range per module instance therefore serves every call; it lives
 * as long as the module and is never deleted (a reloaded module gets its own).
 */
export function noProgress(oc: ProgressRangeModule): OccDisposable {
  let range = ranges.get(oc)
  if (range === undefined) {
    range = new oc.Message_ProgressRange_1()
    ranges.set(oc, range)
  }
  return range
}

/** `BRep_Tool::Triangulation`'s purpose, `Poly_MeshPurpose_NONE`: the face's
 *  active triangulation, whatever it was built for. */
export const MESH_PURPOSE_NONE = 0

/** `BRepClass_FaceClassifier::Perform`'s trailing (useBndBox, gapCheckTol). */
export const FACE_CLASSIFIER_USE_BND_BOX = false
export const FACE_CLASSIFIER_GAP_CHECK_TOL = 0.1
