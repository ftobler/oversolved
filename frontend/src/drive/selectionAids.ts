// A selector in a pick field is an authoring aid: `select`'s grammar names the
// pick, but the document stores only the query string it resolved to. The
// headless drive resolves it against the settled solve before the mutation is
// validated and applied, so one step can name a face without a select round
// trip and a long paste (batch B F2). A selector is never stored, and a surface
// with no solved body set refuses it by name rather than guessing.
//
// The part side of the same idea as drive/assemblyRefs.ts: a selector is
// validated by the kernel grammar, compared against the solve output, and the
// answer is the query `select` would have returned.

import type { BodyResult } from '@/types/cad'
import { selectByPredicate, SelectorError, validateSelector, type Selector } from '@/kernel/select'

export type SelectionAidResolution =
  | { ok: true; mutation: unknown }
  | { ok: false; code: 'invalid-ref' | 'unresolved-ref'; message: string }

const SELECTOR_HINT = 'pass the query string `select` returned instead'

// The untyped JSON object a script step carries before the boundary validates
// it; the same alias the value rules use, so the drive's loose records are one
// named boundary type rather than a feature shape.
type RawStep = { [key: string]: unknown }

function isRecord(value: unknown): value is RawStep {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The selector a `{selector}` pick carries, or null when the value is not that
 *  form. The grammar check is the `select` tool's own, so the sugar and the
 *  refusals cannot drift; it throws SelectorError on a malformed expression. */
function selectorOf(value: unknown): Selector | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || !isRecord(value.selector)) return null
  return validateSelector(value.selector)
}

function pickOf(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && isRecord(value.selector)
}

/**
 * Whether a step names any pick with a selector, so the caller can pay for a
 * solve to resolve it. A step without one never touches the kernel here.
 */
export function usesSelectionAid(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  switch (raw.type) {
    case 'add_sketch':
    case 'set_feature_plane':
      return pickOf(raw.plane)
    case 'add_shell':
      return Array.isArray(raw.faces) && raw.faces.some(pickOf)
    default:
      return false
  }
}

interface FaceQueries {
  ok: true
  queries: string[]
}

interface FaceRefusal {
  ok: false
  code: 'invalid-ref' | 'unresolved-ref'
  message: string
}

/** Resolve one `{selector}` pick to the face queries it matches. `exactlyOne`
 *  is a sketch plane's rule: a plane sits on one face, while a shell opening
 *  list may name several. */
function resolveFacePick(
  value: unknown,
  bodies: Record<string, BodyResult> | null,
  label: string,
  exactlyOne: boolean,
): FaceQueries | FaceRefusal {
  let selector: Selector | null
  try {
    selector = selectorOf(value)
  } catch (e) {
    if (e instanceof SelectorError) return { ok: false, code: 'invalid-ref', message: `${label}: ${e.message}` }
    throw e
  }
  if (selector === null) {
    return {
      ok: false,
      code: 'invalid-ref',
      message: `${label} must be {selector: <a select selector>} and carry nothing else, `
        + `got ${JSON.stringify(value)}`,
    }
  }
  if (bodies === null) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `${label} names a selector, but the document has no solved bodies yet; `
        + `run a step that builds geometry first, or ${SELECTOR_HINT}`,
    }
  }
  let items
  try {
    items = selectByPredicate(selector, bodies).items
  } catch (e) {
    // The select engine owns the nearest-miss wording, and it throws on both a
    // missing `from` body and an empty match: those are unresolved picks, not
    // malformed expressions, exactly as assemblyRefs classifies them. Anything
    // else is an internal fault and stays loud.
    if (!(e instanceof SelectorError)) throw e
    return { ok: false, code: 'unresolved-ref', message: `${label}: ${e.message}` }
  }
  if (exactlyOne && items.length > 1) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `${label} selector matched ${items.length} items; a sketch plane sits on exactly one face, `
        + `so narrow the selector or ${SELECTOR_HINT}`,
    }
  }
  const notFaces = items.filter(item => item.kind !== 'face')
  if (notFaces.length > 0) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `${label} selector matched ${notFaces.length} non-face item(s) (${notFaces.map(item => item.kind).join(', ')}); `
        + 'only faces are picks here',
    }
  }
  return { ok: true, queries: items.map(item => item.query) }
}

function planeStep(raw: RawStep, bodies: Record<string, BodyResult> | null): SelectionAidResolution {
  if (!pickOf(raw.plane)) return { ok: true, mutation: raw }
  const pick = resolveFacePick(raw.plane, bodies, `${raw.type as string} plane`, true)
  if (!pick.ok) return pick
  return { ok: true, mutation: { ...raw, plane: pick.queries[0] } }
}

function shellStep(raw: RawStep, bodies: Record<string, BodyResult> | null): SelectionAidResolution {
  const faces = raw.faces
  if (!Array.isArray(faces)) return { ok: true, mutation: raw }
  const queries: unknown[] = []
  for (let i = 0; i < faces.length; i++) {
    const entry = faces[i]
    // A string is already the stored form; any other junk is left to the value
    // rules so one boundary keeps the refusal wording.
    if (!pickOf(entry)) {
      queries.push(entry)
      continue
    }
    const pick = resolveFacePick(entry, bodies, `add_shell faces[${i}]`, false)
    if (!pick.ok) return pick
    for (const query of pick.queries) {
      if (!queries.includes(query)) queries.push(query)
    }
  }
  return { ok: true, mutation: { ...raw, faces: queries } }
}

/** Rewrite every selector pick in a part mutation into the query string(s) it
 *  matched. A mutation without a selector comes back unchanged, so the caller
 *  can run this on every step. */
export function resolveSelectionAids(
  raw: unknown,
  bodies: Record<string, BodyResult> | null,
): SelectionAidResolution {
  if (!isRecord(raw)) return { ok: true, mutation: raw }
  switch (raw.type) {
    case 'add_sketch':
    case 'set_feature_plane':
      return planeStep(raw, bodies)
    case 'add_shell':
      return shellStep(raw, bodies)
    default:
      return { ok: true, mutation: raw }
  }
}
