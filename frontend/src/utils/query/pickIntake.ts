import type { PartResult } from '@/types/cad'
import { partIdsOfPick } from './partIdOfPick'
import { stripSelectionWrapper } from './selectionId'

/**
 * A pick field holds IDENTITIES, not selection strings. A part field wants the
 * body an arriving pick lands on (a face, an edge and the whole part are the
 * same want), and every other field wants the stored form of the pick. The want
 * key is that identity as a set: a plain ref names one value, a feature ref in a
 * part field names every body that feature made.
 */
export type WantKey = readonly string[]

export type WantKeyResult = { keys: WantKey } | { refused: string }

/** Map one selection id (or one held value) to what the field holds for it. */
export type WantKeyOf = (selectionId: string) => WantKeyResult

export interface PickBatch {
  // Arriving ids to add, in arrival order, one per want key.
  add: string[]
  // Indices into the held values this batch takes out.
  remove: number[]
}

export interface PickIntake extends PickBatch {
  // Why a pick was refused, in arrival order. The editor voices the first one.
  refused: string[]
}

export interface PickIntakeOptions {
  // The text a held value is named by in an "already in" refusal. The widget
  // passes the chip's own label so the message names the part, not a raw query.
  labelOf?: (heldValue: string) => string
}

const NO_PART_REASON = 'pick a face, edge or part'

/**
 * The want key of an element field: the stored form of the id. `transform` is
 * applied on arrival AND on the held values, which is what lets a re-click of a
 * rewritten value (a sketch vertex, an absolute entity ref) toggle the value
 * out instead of re-adding it.
 */
export function identityWantKey(transform?: (selectionId: string) => string): WantKeyOf {
  return (selectionId) => ({ keys: [transform ? transform(selectionId) : selectionId] })
}

/** The body reference a pick names, before store lookup. */
function partRefOfPick(selectionId: string): string {
  // The legacy `body:` selection wrapper names a body directly; every other
  // wrapper is stripped to its inner query here.
  if (selectionId.startsWith('body:')) return '@' + selectionId.slice('body:'.length)
  return stripSelectionWrapper(selectionId)
}

/**
 * The want key of a field that names whole bodies: the body ids a pick resolves
 * to. Resolution shares `partIdsOfPick` with the chip's labelling and the
 * kernel's own `resolvePartIds`, so a pick and the solve cannot disagree about
 * which part it is. A pick that lands on no body (a plane, a sketch entity, a
 * construction point) is refused here, with the field's own words.
 *
 * The caller must pass the PRE-feature bodies (the pick layer): in a Delete Part
 * edit the preview has already lost the part being compared.
 */
export function partsWantKey(parts: Record<string, PartResult> | null | undefined): WantKeyOf {
  return (selectionId) => {
    const ids = partIdsOfPick(partRefOfPick(selectionId), parts)
    if (ids.length === 0) return { refused: NO_PART_REASON }
    return { keys: [...ids].sort() }
  }
}

const sameKeys = (a: WantKey, b: WantKey): boolean =>
  a.length === b.length && a.every((key, i) => key === b[i])

const containsKeys = (held: WantKey, pick: WantKey): boolean =>
  held.length > pick.length && pick.every(key => held.includes(key))

/**
 * Plan one arriving selection batch against the field's held values.
 *
 * A click is a batch of one and a lasso is the whole boxed set; the difference
 * is the user's intent. A click on a value the field already holds is the
 * removal pick for that value, even when it names the value through a different
 * face or edge (the user's rule: picking a second edge of a picked part removes
 * the part). A lasso only adds, and skips what is already held, so a box dragged
 * over three parts cannot silently take a fourth out.
 *
 * Each arrival is deduplicated by want key, first id wins, so a box over a
 * part's twelve faces adds that part once. A held value that names several
 * bodies (`@ex1`, every body that feature made) is never removed for one of its
 * siblings; the click is refused as already present, because removing it would
 * drop the siblings too.
 */
export function planPickIntake(
  incoming: readonly string[],
  held: readonly string[],
  wantKeyOf: WantKeyOf,
  opts?: PickIntakeOptions,
): PickIntake {
  const heldKeys = held.map((value) => {
    const result = wantKeyOf(value)
    return 'keys' in result ? [...result.keys].sort() : []
  })
  const add: string[] = []
  const remove: number[] = []
  const refused: string[] = []
  const seen = new Set<string>()
  // One id is a click; anything more is a lasso, including a box that covers
  // exactly one element but resolved to a single query.
  const isClick = incoming.length === 1

  for (const id of incoming) {
    const result = wantKeyOf(id)
    if ('refused' in result) {
      refused.push(result.refused)
      continue
    }
    const key = [...result.keys].sort()
    if (key.length === 0) {
      refused.push(NO_PART_REASON)
      continue
    }
    const signature = key.join('\u0000')
    if (seen.has(signature)) continue
    seen.add(signature)

    const heldIndex = heldKeys.findIndex(heldKey => sameKeys(heldKey, key))
    if (heldIndex >= 0) {
      // Click: this is the removal pick for the held value. Lasso: additive
      // only, so a covered value that is already held is left in place.
      if (isClick) remove.push(heldIndex)
      continue
    }
    const covering = isClick
      ? heldKeys.findIndex(heldKey => containsKeys(heldKey, key))
      : -1
    if (covering >= 0) {
      const label = opts?.labelOf ? opts.labelOf(held[covering]) : held[covering]
      refused.push(`already in ${label}`)
      continue
    }
    add.push(id)
  }

  return { add, remove, refused }
}
