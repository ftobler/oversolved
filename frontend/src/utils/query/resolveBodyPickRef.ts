// Shared tail for the two body-ref resolvers: collapse a `body:`/`@.../`
// selection to a single feature segment, then coerce any bare `@ref` into the
// canonical `@body_<...>` form. Inputs that match no branch pass through.
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
 * Convert a viewport selection ID to a body reference suitable for the solver.
 *
 * face:featureId:innerQuery  →  innerQuery  (backend ? branch coerces face→body)
 * body:body_ex1              →  @body_ex1
 * @ex1/face/0                →  @body_ex1
 * @body_ex1 / ?...           →  unchanged  (already a valid body or ? query)
 */
export function resolveBodyPickRef(id: string): string {
  if (id.startsWith('face:')) {
    return id.split(':').slice(2).join(':')
  }
  return normalizeBodyRef(id)
}

/**
 * Convert a viewport selection ID to a body reference for a merge/boolean
 * target field (extrude/revolve merge_target). Unlike resolveBodyPickRef, a
 * `?` ancestry query is coerced to `@body_<first-segment>` rather than passed
 * through. Shared by ExtrudeEditor and RevolveEditor.
 */
export function resolveBodyMergeRef(id: string): string {
  if (id.startsWith('?')) {
    return '@body_' + id.slice(1).split('/')[0]
  }
  return normalizeBodyRef(id)
}

/**
 * Convert a viewport selection ID to a revolve axis query. face/edge selections
 * keep their inner ancestry query; an entity selection becomes an absolute ref.
 */
export function resolveAxisQuery(selectionId: string): string {
  if (selectionId.startsWith('face:')) {
    return selectionId.split(':').slice(2).join(':')
  }
  if (selectionId.startsWith('entity:')) {
    return '@' + selectionId.split(':').slice(1).join('/')
  }
  if (selectionId.startsWith('edge:')) {
    return selectionId.split(':').slice(2).join(':')
  }
  return selectionId
}
