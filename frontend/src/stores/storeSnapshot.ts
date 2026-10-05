// The merge behind every `setSnapshot` action.
//
// `setSnapshot` mirrors React-owned state into a module-level Zustand store,
// while the fields the store owns (the solve lifecycle, transient pick and drag
// state, the undo stacks) must keep their live values. The merge used to index
// both objects through `as unknown as Record<string, unknown>`, which erased the
// snapshot's type at exactly the seam where a malformed value would silently
// poison every reader downstream. This keeps the merge typed end to end and
// turns "a non-object reached the store" into a loud error instead of a spread
// of nothing.

/** True for a non-null, non-array object: the shape `setSnapshot` mirrors. */
export function isSnapshotObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Copy `data` and restore `ownedFields` from the live `prev` state. The result
 * keeps the shape of `data`, so callers need no cast. The field names are
 * `keyof T`, so naming a field that does not exist on the state is a compile
 * error; a real field dropped from `ownedFields`, however, silently stops being
 * preserved, which is the direction the type cannot catch.
 *
 * `data` is built in-process from React state, not parsed from storage, so the
 * runtime checks here are modest: `data` must be a plain object (a primitive or
 * array would otherwise be spread into an empty snapshot) and every owned field
 * must already exist on the live state it is read from.
 */
export function mergeSnapshot<T extends object>(
  data: T,
  prev: T,
  ownedFields: readonly (keyof T)[],
): T {
  if (!isSnapshotObject(data)) {
    throw new TypeError('mergeSnapshot: snapshot must be a plain object')
  }
  const merged = { ...data }
  for (const field of ownedFields) {
    if (!(field in prev)) {
      throw new TypeError(`mergeSnapshot: owned field "${String(field)}" is missing from the live state`)
    }
    // Object.assign rather than `merged[field] = ...`: a generic indexed write
    // of `T[keyof T]` is rejected by the checker, and this keeps the write
    // typed without a cast.
    Object.assign(merged, { [field]: prev[field] })
  }
  return merged
}

/**
 * Copy `ownedFields` out of `source`, skipping any listed in `omit`. Used to
 * reset the store-owned interaction fields to their defaults: the result is a
 * partial the caller hands to `set`, which leaves every unlisted field (the
 * mirrored scene, the undo stacks) untouched.
 */
export function pickOwnedFields<T extends object, K extends keyof T>(
  source: T,
  ownedFields: readonly K[],
  omit: readonly K[] = [],
): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {}
  for (const field of ownedFields) {
    if (omit.includes(field)) continue
    Object.assign(picked, { [field]: source[field] })
  }
  return picked
}
