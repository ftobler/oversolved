// What a mirror reflects. The field is explicit on new rows; absence means
// body, because every document authored before the feature subject existed is
// a whole-body mirror. Unlike the pattern there is no source inference ladder:
// a body mirror always named its body, so a row with sources and no subject is
// a document the editor wrote when the subject was switched, not a legacy
// spelling to guess at.
export type MirrorSubjectChoice = 'body' | 'feature'

export function mirrorSubject(sub: { subject?: unknown } | undefined | null): MirrorSubjectChoice {
  return sub !== undefined && sub !== null && sub.subject === 'feature' ? 'feature' : 'body'
}
