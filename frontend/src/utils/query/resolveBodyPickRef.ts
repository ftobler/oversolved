import { stripSelectionWrapper } from './selectionId'

// Collapse a `body:`/`@.../` selection to a single segment, then coerce any
// bare `@ref` into the canonical `@body_<...>` form. Inputs that match no
// branch pass through. `@body_ex1_1/face/0` keeps its sibling suffix: the
// segment before the first slash is the whole body id.
function normalizeBodyRef(ref: string): string {
  if (ref.startsWith('body:')) {
    ref = '@' + ref.slice(5)
  } else if (ref.startsWith('@') && ref.includes('/')) {
    ref = '@' + ref.slice(1).split('/')[0]
  }
  if (ref.startsWith('@') && !ref.startsWith('@body_')) {
    ref = '@body_' + ref.slice(1)
  }
  return ref
}

/**
 * Convert a viewport selection ID to a body reference for any field that names
 * a whole body (circular_array `source_body`, extrude/revolve `merge_target`).
 * Picking a face of the body is the natural gesture, so a `face:` selection
 * yields its inner ancestry query and a `?` query passes through untouched:
 * both are body-exact and resolve to the owning body in the kernel
 * (`resolveBody` / `resolveBodyIds`). An `edge:` pick now yields its inner
 * query too, through the shared wrapper stripper, and resolves the same way.
 *
 * The merge-target field used to have its own variant that mapped a `?` query
 * to `'@body_' + id.slice(1).split('/')[0]` -- meaningless string surgery on a
 * query, turning `?4;@ex1:solid` into the literal id `@body_4;@ex1:solid`,
 * which was then PERSISTED as `merge_target` where it could only fail to
 * resolve. The two fields want the same thing; there is one function.
 */
export function resolveBodyPickRef(id: string): string {
  if (id.startsWith('face:') || id.startsWith('edge:')) {
    return stripSelectionWrapper(id)
  }
  return normalizeBodyRef(id)
}

/**
 * Convert a viewport selection ID to a revolve axis query. face/edge selections
 * keep their inner ancestry query; an entity/vertex selection becomes an
 * absolute ref. That is exactly the shared wrapper strip, so the whole function
 * is one call into it (entity, vertex and edge all used to be handled by
 * hand-rolled copies that drifted).
 */
export function resolveAxisQuery(selectionId: string): string {
  return stripSelectionWrapper(selectionId)
}
