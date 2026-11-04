// What a pattern repeats. The field is explicit on new rows; a row authored
// before it existed is read from the source it actually names, so a legacy
// feature pattern keeps solving and editing as a feature pattern instead of
// silently becoming a body pattern that asks for a source body.
export type PatternSubjectChoice = 'body' | 'feature'

export function patternSubject(sub: Record<string, unknown> | undefined | null): PatternSubjectChoice {
  if (sub === undefined || sub === null) return 'body'
  const explicit = sub.subject
  if (explicit === 'body' || explicit === 'feature') return explicit
  const sourceFeature = sub.source_feature
  const sourceBody = sub.source_body
  return typeof sourceFeature === 'string' && sourceFeature !== ''
    && !(typeof sourceBody === 'string' && sourceBody !== '')
    ? 'feature'
    : 'body'
}
