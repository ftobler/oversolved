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
import {
  PREDICATE_KEYS, selectByPredicate, SelectorError, validateSelector, type SelectKind, type Selector,
} from '@/kernel/select'

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

const UNKNOWN_SELECTOR_KEY = /has unknown key "([^"]+)"/

/**
 * A predicate key placed at the selector's top level is a real practice-round
 * mistake: `{selector: {type: "flatface"}}`. The kernel names the unknown key
 * but not the shape, so add the shape and the corrected spelling. The predicate
 * list is the grammar's own PREDICATE_KEYS, so a new predicate cannot drift.
 */
function selectorShapeHint(message: string, kind: SelectKind): string {
  const key = UNKNOWN_SELECTOR_KEY.exec(message)?.[1]
  // The list is a const tuple, so a string membership check needs the widening.
  if (key === undefined || !(PREDICATE_KEYS as readonly string[]).includes(key)) return message
  const sample = key === 'type' ? (kind === 'face' ? '"flatface"' : '"line"') : '...'
  return `${message}; a selector is {from?, kind, where} and "${key}" is a predicate, so it goes under "where": ` +
    `{selector: {kind: "${kind}", where: {${key}: ${sample}}}}`
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
    case 'add_fillet':
    case 'add_chamfer':
      return Array.isArray(raw.edges) && raw.edges.some(pickOf)
    default:
      return false
  }
}

interface PickQueries {
  ok: true
  queries: string[]
}

interface PickRefusal {
  ok: false
  code: 'invalid-ref' | 'unresolved-ref'
  message: string
}

/** Resolve one `{selector}` pick to the queries it matches. `kind` is the
 *  element the field accepts; `exactlyOne` is a sketch plane's rule: a plane
 *  sits on one face, while a shell opening or fillet edge list may name
 *  several. */
function resolvePick(
  value: unknown,
  bodies: Record<string, BodyResult> | null,
  label: string,
  kind: SelectKind,
  exactlyOne: boolean,
): PickQueries | PickRefusal {
  let selector: Selector | null
  try {
    selector = selectorOf(value)
  } catch (e) {
    if (e instanceof SelectorError) {
      return { ok: false, code: 'invalid-ref', message: `${label}: ${selectorShapeHint(e.message, kind)}` }
    }
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
  const wrongKind = items.filter(item => item.kind !== kind)
  if (wrongKind.length > 0) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `${label} selector matched ${wrongKind.length} non-${kind} item(s) `
        + `(${wrongKind.map(item => item.kind).join(', ')}); only ${kind}s are picks here`,
    }
  }
  return { ok: true, queries: items.map(item => item.query) }
}

function planeStep(raw: RawStep, bodies: Record<string, BodyResult> | null): SelectionAidResolution {
  if (!pickOf(raw.plane)) return { ok: true, mutation: raw }
  const pick = resolvePick(raw.plane, bodies, `${raw.type as string} plane`, 'face', true)
  if (!pick.ok) return pick
  return { ok: true, mutation: { ...raw, plane: pick.queries[0] } }
}

// A pick list keeps the authored order: a string entry is already the stored
// form and passes through, while a selector expands in place to every query it
// matched, deduped so two selectors naming one edge store it once.
function pickListStep(
  raw: RawStep,
  field: string,
  bodies: Record<string, BodyResult> | null,
  kind: SelectKind,
): SelectionAidResolution {
  const entries = raw[field]
  if (!Array.isArray(entries)) return { ok: true, mutation: raw }
  const queries: unknown[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    // A string is already the stored form; any other junk is left to the value
    // rules so one boundary keeps the refusal wording.
    if (!pickOf(entry)) {
      queries.push(entry)
      continue
    }
    const pick = resolvePick(entry, bodies, `${raw.type as string} ${field}[${i}]`, kind, false)
    if (!pick.ok) return pick
    for (const query of pick.queries) {
      if (!queries.includes(query)) queries.push(query)
    }
  }
  return { ok: true, mutation: { ...raw, [field]: queries } }
}

function shellStep(raw: RawStep, bodies: Record<string, BodyResult> | null): SelectionAidResolution {
  return pickListStep(raw, 'faces', bodies, 'face')
}

function edgeStep(raw: RawStep, bodies: Record<string, BodyResult> | null): SelectionAidResolution {
  return pickListStep(raw, 'edges', bodies, 'edge')
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
    case 'add_fillet':
    case 'add_chamfer':
      return edgeStep(raw, bodies)
    default:
      return { ok: true, mutation: raw }
  }
}
