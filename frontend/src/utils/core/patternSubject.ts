// What a pattern repeats. The field is explicit on new rows; a row authored
// before it existed is read from the source it actually names, so a legacy
// feature pattern keeps solving and editing as a feature pattern instead of
// silently becoming a body pattern that asks for a source body.
export type PatternSubjectChoice = 'body' | 'feature'

export function patternSubject(sub: Record<string, unknown> | undefined | null): PatternSubjectChoice {
  if (sub === undefined || sub === null) return 'body'
  const explicit = sub.subject
  if (explicit === 'body' || explicit === 'feature') return explicit
  const sourceFeatures = sub.source_features
  const sourceFeature = sub.source_feature
  const sourcePart = sub.source_body
  const namesFeatures = (Array.isArray(sourceFeatures) && sourceFeatures.length > 0)
    || (typeof sourceFeature === 'string' && sourceFeature !== '')
  return namesFeatures && !(typeof sourcePart === 'string' && sourcePart !== '')
    ? 'feature'
    : 'body'
}
