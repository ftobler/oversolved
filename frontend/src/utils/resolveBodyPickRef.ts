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
  let ref = id
  if (id.startsWith('body:')) {
    ref = '@' + id.slice(5)
  } else if (id.startsWith('@') && id.includes('/')) {
    ref = '@' + id.slice(1).split('/')[0]
  }
  if (ref.startsWith('@') && !ref.startsWith('@body_')) {
    ref = '@body_' + ref.slice(1)
  }
  return ref
}
