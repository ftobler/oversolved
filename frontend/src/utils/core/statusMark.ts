/**
 * The one shape every editor status is reported in.
 *
 * There are two levels a user can observe, and both carry this mark:
 *   - a FIELD mark: input the field refused before anything reached the
 *     document (a pick its rule rejects, a value that does not evaluate or
 *     breaks the field's rule). Always an error: the input did not take.
 *   - an ITEM mark: what the last solve said about a feature, mate or part.
 *     'error' when nothing usable was built, 'warning' when the result is
 *     valid but not everything asked for happened (partial picks, a fallback,
 *     an operation that changed nothing).
 * Every surface renders a mark the same way: the tree row tints its name by
 * level and shows the message on hover, and the open editor shows the same
 * message as a line (components/shared/StatusMessage.tsx). No consumer invents
 * its own severity or wording.
 */
export type StatusLevel = 'error' | 'warning'

export interface StatusMark {
  // True when the result is not what was asked for. Distinct from `level`:
  // an underconstrained assembly is a warning that has not failed.
  failed: boolean
  // What the user sees: null for no mark at all.
  level: StatusLevel | null
  // Human-readable cause, '' only when there is no mark.
  message: string
}

export const NO_MARK: StatusMark = { failed: false, level: null, message: '' }

/** A field refusal: what kind of input was refused and why. The field rule
 *  supplies the reason, so the message cannot misstate what the field takes. */
export function fieldRefusal(kind: 'Pick' | 'Value', reason: string | null): StatusMark {
  return reason === null ? NO_MARK : { failed: true, level: 'error', message: `${kind} refused: ${reason}` }
}

/** A field refusal as dialog text, for the viewport value dialogs whose
 *  `validate` returns the line to print (null accepts). */
export function refusalText(kind: 'Pick' | 'Value', reason: string | null): string | null {
  return reason === null ? null : fieldRefusal(kind, reason).message
}

/** The tree-row name modifier for a mark, the same for every row kind. */
export function markNameClass(mark: Pick<StatusMark, 'level'>): string {
  return mark.level ? ` feature-name-${mark.level}` : ''
}
