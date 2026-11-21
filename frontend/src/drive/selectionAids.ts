// A selector in a pick field is an authoring aid: `select`'s grammar names the
// pick, but the document stores only the query string it resolved to. The
// headless drive resolves it against the settled solve before the mutation is
// validated and applied, so one step can name a face or a projection source
// without a select round trip and a long paste (batch B F2). A selector is never
// stored, and a surface with no solved body set refuses it by name rather than
// guessing.
//
// The part side of the same idea as drive/assemblyRefs.ts: a selector is
// validated by the kernel grammar, compared against the solve output, and the
// answer is the query `select` would have returned.

import type { PartResult } from '@/types/cad'
import {
  PREDICATE_KEYS, selectByPredicate, SelectorError, validateSelector, type SelectItem, type SelectKind, type Selector,
} from '@/kernel/select'
import { projectedKindForEdge } from '@/tools/operandProjection'

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

/** Whether a value is the `{selector}` object and nothing else. Exported so the
 *  applier-side guard and the value rules read one spelling of the aid. */
export function pickOf(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && isRecord(value.selector)
}

// Anchored at the selector root: a nested predicate's own unknown key is a
// different mistake and must keep its plain message.
const UNKNOWN_SELECTOR_KEY = /^selector has unknown key "([^"]+)"/

const SELECT_KINDS: readonly SelectKind[] = ['edge', 'face', 'vertex']

/** The kind a raw `{selector}` pick declares, when it names a valid one. A
 *  malformed selector is exactly the case a hint is needed for, so this reads
 *  the declared kind without trusting the grammar to validate. */
export function declaredSelectorKind(value: unknown): SelectKind | null {
  if (!isRecord(value) || !isRecord(value.selector)) return null
  const kind = value.selector.kind
  // The list is a const tuple, so a string membership check needs the widening.
  return typeof kind === 'string' && (SELECT_KINDS as readonly string[]).includes(kind)
    ? kind as SelectKind
    : null
}

/**
 * A predicate key placed at the selector's top level is a real practice-round
 * mistake: `{selector: {type: "flatface"}}`. The kernel names the unknown key
 * but not the shape, so add the shape and the corrected spelling. The predicate
 * list is the grammar's own PREDICATE_KEYS, so a new predicate cannot drift.
 * Exported so the browser bridge (mutationValues) gives the same correction as
 * the drive, off the selector's own declared kind.
 */
export function selectorShapeHint(message: string, kind: SelectKind): string {
  const key = UNKNOWN_SELECTOR_KEY.exec(message)?.[1]
  // The list is a const tuple, so a string membership check needs the widening.
  if (key === undefined || !(PREDICATE_KEYS as readonly string[]).includes(key)) return message
  const sample = key === 'type' ? (kind === 'face' ? '"flatface"' : '"line"') : '...'
  return `${message}; a selector is {from?, kind, where} and "${key}" is a predicate, so it goes under "where": ` +
    `{selector: {kind: "${kind}", where: {${key}: ${sample}}}}`
}

interface PickQueries {
  ok: true
  queries: string[]
  // The matched elements, for a field whose stored value depends on the element
  // itself (a projection's entity kind) rather than on the query alone.
  items: SelectItem[]
}

interface PickRefusal {
  ok: false
  code: 'invalid-ref' | 'unresolved-ref'
  message: string
}

/** How many element kinds a field takes. `null` accepts whatever kind the
 *  selector names, because the field takes more than one (a projection source
 *  is an edge, vertex or face) and the caller reads the matched kind back off
 *  the item. `oneOnly` is the sentence a multi-match refusal carries, naming
 *  what the field sits on; null means the field expands to every match. */
export interface PickRule {
  kinds: readonly SelectKind[] | null
  oneOnly: string | null
}

/** How a pick field holds its selector: a list expands in place to every match,
 *  a single pick needs exactly one. */
export type SelectionAidMode = 'list' | 'single'

/** One field of one mutation that takes a selector instead of a query string.
 *  `path` walks from the step root. A setter keeps its value under `value` and
 *  names the field in `field`, so the same row shape covers both spellings and
 *  the two cannot describe different pick rules. */
export interface SelectionAid {
  path: readonly string[]
  field?: string
  mode: SelectionAidMode
  rule: PickRule
  // A projection source with no authored `kind` infers one from the element the
  // selector matched, which is the only aid whose stored value depends on more
  // than the query.
  inferKind?: boolean
}

const PLANE_PICK: PickRule = { kinds: ['face'], oneOnly: 'a plane pick sits on exactly one face' }
const FACE_PICK: PickRule = { kinds: ['face'], oneOnly: 'this field takes exactly one face' }
const EDGE_PICK: PickRule = { kinds: ['edge'], oneOnly: 'this field takes exactly one edge' }
const VERTEX_PICK: PickRule = { kinds: ['vertex'], oneOnly: 'this field takes exactly one vertex' }
const EDGE_OR_FACE_PICK: PickRule = {
  kinds: ['edge', 'face'],
  oneOnly: 'this field takes exactly one edge or face',
}
const FACE_OR_VERTEX_PICK: PickRule = {
  kinds: ['face', 'vertex'],
  oneOnly: 'this field takes exactly one face or vertex',
}
const ANY_PICK: PickRule = {
  kinds: null,
  oneOnly: 'this field takes exactly one edge, vertex or face',
}
const PROJECTION_SOURCE_PICK: PickRule = {
  kinds: null,
  oneOnly: 'a projection source is exactly one edge, vertex or face',
}
const FACE_LIST: PickRule = { kinds: ['face'], oneOnly: null }
const EDGE_LIST: PickRule = { kinds: ['edge'], oneOnly: null }
const ANY_LIST: PickRule = { kinds: null, oneOnly: null }

const pick = (path: string | readonly string[], mode: SelectionAidMode, rule: PickRule): SelectionAid =>
  ({ path: typeof path === 'string' ? [path] : path, mode, rule })
const setter = (field: string, mode: SelectionAidMode, rule: PickRule): SelectionAid =>
  ({ path: ['value'], field, mode, rule })

// The plane definition's point-like fields: each takes a vertex pick, beside the
// world coordinates `origin` also allows (an array is not a selector).
const PLANE_VERTEX_FIELDS = ['point', 'p1', 'p2', 'p3', 'origin'] as const
const PLANE_EDGE_FIELDS = ['edge', 'line'] as const

/**
 * Every mutation field that takes a selector, keyed by mutation type. The drive
 * resolves this table and the value rules refuse from it, so a field cannot be
 * covered on one path and forgotten on the other. A setter's row names the one
 * field its value is for; an add row walks a static path.
 */
export const SELECTION_AIDS: Readonly<Record<string, readonly SelectionAid[]>> = {
  add_sketch: [pick('plane', 'single', PLANE_PICK)],
  set_feature_plane: [pick('plane', 'single', PLANE_PICK)],
  add_projected_entity: [
    { ...pick('source', 'single', PROJECTION_SOURCE_PICK), inferKind: true },
  ],
  add_shell: [pick('faces', 'list', FACE_LIST)],
  add_fillet: [pick('edges', 'list', EDGE_LIST)],
  add_chamfer: [pick('edges', 'list', EDGE_LIST)],
  add_delete_face: [pick('faces', 'list', FACE_LIST)],
  add_move_face: [pick('faces', 'list', FACE_LIST)],
  add_instance_pattern: [pick('targets', 'list', ANY_LIST)],
  add_wrap: [pick('target', 'single', FACE_PICK)],
  add_extrude: [pick('up_to', 'single', FACE_OR_VERTEX_PICK)],
  add_revolve: [pick('axis', 'single', EDGE_PICK)],
  add_mirror: [pick('plane', 'single', PLANE_PICK)],
  add_split: [pick('plane', 'single', PLANE_PICK)],
  add_plane: [
    pick(['definition', 'face'], 'single', FACE_PICK),
    ...PLANE_EDGE_FIELDS.map(field => pick(['definition', field], 'single', EDGE_PICK)),
    ...PLANE_VERTEX_FIELDS.map(field => pick(['definition', field], 'single', VERTEX_PICK)),
  ],
  add_helix: [pick('reference', 'single', EDGE_OR_FACE_PICK)],
  add_linear_pattern: [
    pick('direction_query', 'single', EDGE_OR_FACE_PICK),
    pick('direction_2_query', 'single', EDGE_OR_FACE_PICK),
  ],
  add_circular_pattern: [pick('axis', 'single', EDGE_OR_FACE_PICK)],
  add_curve_pattern: [pick('normal_ref', 'single', EDGE_OR_FACE_PICK)],
  add_transform: [
    pick('rotation_axis', 'single', EDGE_PICK),
    pick('translation_from', 'single', VERTEX_PICK),
    pick('translation_to', 'single', VERTEX_PICK),
    pick('scale_center_from', 'single', VERTEX_PICK),
  ],
  add_shell_face: [pick('faceQuery', 'single', FACE_PICK)],
  add_fillet_edge: [pick('edgeQuery', 'single', EDGE_PICK)],
  add_chamfer_edge: [pick('edgeQuery', 'single', EDGE_PICK)],
  add_delete_face_ref: [pick('faceQuery', 'single', FACE_PICK)],
  add_move_face_ref: [pick('faceQuery', 'single', FACE_PICK)],
  add_instance_pattern_target: [pick('targetQuery', 'single', ANY_PICK)],

  set_wrap_field: [setter('target', 'single', FACE_PICK)],
  set_extrude_field: [setter('up_to', 'single', FACE_OR_VERTEX_PICK)],
  set_revolve_field: [setter('axis', 'single', EDGE_PICK)],
  set_mirror_field: [setter('plane', 'single', PLANE_PICK)],
  set_split_field: [setter('plane', 'single', PLANE_PICK)],
  set_plane_definition_field: [
    setter('face', 'single', FACE_PICK),
    ...PLANE_EDGE_FIELDS.map(field => setter(field, 'single', EDGE_PICK)),
    ...PLANE_VERTEX_FIELDS.map(field => setter(field, 'single', VERTEX_PICK)),
  ],
  set_helix_field: [setter('reference', 'single', EDGE_OR_FACE_PICK)],
  set_linear_pattern_field: [
    setter('direction_query', 'single', EDGE_OR_FACE_PICK),
    setter('direction_2_query', 'single', EDGE_OR_FACE_PICK),
  ],
  set_circular_pattern_field: [setter('axis', 'single', EDGE_OR_FACE_PICK)],
  set_curve_pattern_field: [setter('normal_ref', 'single', EDGE_OR_FACE_PICK)],
  set_transform_field: [
    setter('rotation_axis', 'single', EDGE_PICK),
    setter('translation_from', 'single', VERTEX_PICK),
    setter('translation_to', 'single', VERTEX_PICK),
    setter('scale_center_from', 'single', VERTEX_PICK),
  ],
  set_move_face_field: [setter('faces', 'list', FACE_LIST)],
  set_instance_pattern_field: [setter('targets', 'list', ANY_LIST)],
  set_shell_field: [setter('faces', 'list', FACE_LIST)],
  set_fillet_field: [setter('edges', 'list', EDGE_LIST)],
  set_chamfer_field: [setter('edges', 'list', EDGE_LIST)],
}

const NO_AIDS: readonly SelectionAid[] = []

/** The selector fields of one mutation type; empty for a type with none. The
 *  own-key check keeps a prototype name ('constructor', '__proto__') from
 *  resolving as a table row, the same guard the catalog uses. */
export function selectionAidsFor(type: string): readonly SelectionAid[] {
  return Object.hasOwn(SELECTION_AIDS, type) ? SELECTION_AIDS[type] : NO_AIDS
}

/** The aid a setter's named field carries, or undefined when that field is not a
 *  pick the drive resolves. */
export function selectionAidFor(type: string, field: string): SelectionAid | undefined {
  return selectionAidsFor(type).find(aid => aid.field === field)
}

/** Read one aid's value out of a raw step, following its path. */
export function selectionAidValue(raw: unknown, aid: SelectionAid): unknown {
  let value: unknown = raw
  for (const key of aid.path) {
    if (!isRecord(value)) return undefined
    value = value[key]
  }
  return value
}

/** Whether the aid names a field this step carries: a setter names one field in
 *  `field`, while an add's path is static. */
export function selectionAidApplies(raw: unknown, aid: SelectionAid): boolean {
  return aid.field === undefined || (isRecord(raw) && raw.field === aid.field)
}

/** The label a refusal names. A setter's value is one field, so it is labelled
 *  by that field rather than by the wire key `value`. */
export function selectionAidLabel(type: string, aid: SelectionAid): string {
  return aid.field === undefined ? `${type} ${aid.path.join('.')}` : `${type} ${aid.field}`
}

/** Whether a step names any pick with a selector, so the caller can pay for a
 *  solve to resolve it. A step without one never touches the kernel here. */
export function usesSelectionAid(raw: unknown): boolean {
  return unresolvedSelectionAid(raw) !== null
}

/** The first covered field still carrying a selector, or null. The applier
 *  funnel uses this to refuse a selector that bypassed both the drive and the
 *  value rules, so no document ever stores an authoring aid. */
export function unresolvedSelectionAid(raw: unknown): string | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null
  for (const aid of selectionAidsFor(raw.type)) {
    if (!selectionAidApplies(raw, aid)) continue
    const value = selectionAidValue(raw, aid)
    const carries = aid.mode === 'list'
      ? Array.isArray(value) && value.some(pickOf)
      : pickOf(value)
    if (carries) return selectionAidLabel(raw.type, aid)
  }
  return null
}

/** Resolve one `{selector}` pick to the queries it matches. */
function resolvePick(
  value: unknown,
  parts: Record<string, PartResult> | null,
  label: string,
  rule: PickRule,
): PickQueries | PickRefusal {
  let selector: Selector | null
  try {
    selector = selectorOf(value)
  } catch (e) {
    if (e instanceof SelectorError) {
      // The selector's own kind is the example the hint should suggest, and the
      // grammar check that just failed may be why it is not listed in the rule.
      return {
        ok: false,
        code: 'invalid-ref',
        message: `${label}: ${selectorShapeHint(e.message, declaredSelectorKind(value) ?? rule.kinds?.[0] ?? 'edge')}`,
      }
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
  if (parts === null) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `${label} names a selector, but the document has no solved parts yet; `
        + `run a step that builds geometry first, or ${SELECTOR_HINT}`,
    }
  }
  let items
  try {
    items = selectByPredicate(selector, parts).items
  } catch (e) {
    // The select engine owns the nearest-miss wording, and it throws on both a
    // missing `from` body and an empty match: those are unresolved picks, not
    // malformed expressions, exactly as assemblyRefs classifies them. Anything
    // else is an internal fault and stays loud.
    if (!(e instanceof SelectorError)) throw e
    return { ok: false, code: 'unresolved-ref', message: `${label}: ${e.message}` }
  }
  if (rule.oneOnly !== null && items.length > 1) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `${label} selector matched ${items.length} items; ${rule.oneOnly}, `
        + `so narrow the selector or ${SELECTOR_HINT}`,
    }
  }
  const kinds = rule.kinds
  if (kinds !== null) {
    const wrongKind = items.filter(item => !kinds.includes(item.kind))
    if (wrongKind.length > 0) {
      return {
        ok: false,
        code: 'unresolved-ref',
        message: `${label} selector matched ${wrongKind.length} ${wrongKindPhrase(kinds)} item(s) `
          + `(${wrongKind.map(item => item.kind).join(', ')}); ${onlyPhrase(kinds)}`,
      }
    }
  }
  return { ok: true, queries: items.map(item => item.query), items }
}

// The refusal sentence for a wrong element kind. One kind keeps the round
// "non-face"/"only faces are picks here" wording the value rules share; a pair
// names both so a face selector on an edge field teaches the alternative.
function wrongKindPhrase(kinds: readonly SelectKind[]): string {
  return kinds.length === 1 ? `non-${kinds[0]}` : `non-${kinds.join('-or-')}`
}

function onlyPhrase(kinds: readonly SelectKind[]): string {
  return kinds.length === 1
    ? `only ${kinds[0]}s are picks here`
    : `only ${kinds.join(' or ')} picks are accepted here`
}

function withValueAt(raw: RawStep, path: readonly string[], value: unknown): RawStep {
  const [key, ...rest] = path
  if (key === undefined) return raw
  if (rest.length === 0) return { ...raw, [key]: value }
  const child = raw[key]
  return { ...raw, [key]: withValueAt(isRecord(child) ? child : {}, rest, value) }
}

/** The sketch entity kind an omitted projection `kind` infers from the element
 *  the selector matched. An edge uses the UI's own mapping (projectedKindForEdge),
 *  so the drive and the project tool cannot declare different curve kinds for
 *  one edge. A vertex projects as its point. A face is the one divergence: the
 *  drive infers a point (its centroid, what the lowerer reads), while the UI
 *  expands a face pick into its boundary wire when the body reports one. The
 *  kind is a pick-time hint either way, so the lowerer's resolved geometry wins. */
function projectedKindOf(item: SelectItem): string {
  return item.kind === 'edge' ? projectedKindForEdge(item.geometry.kind) : 'point'
}

/** The single-pick handler: a selector resolves to the one query its rule
 *  matched. A string or missing value is already the stored form. */
function singleStep(
  raw: RawStep,
  aid: SelectionAid,
  parts: Record<string, PartResult> | null,
): SelectionAidResolution {
  const value = selectionAidValue(raw, aid)
  if (!pickOf(value)) return { ok: true, mutation: raw }
  const pickResult = resolvePick(value, parts, selectionAidLabel(raw.type as string, aid), aid.rule)
  if (!pickResult.ok) return pickResult
  return { ok: true, mutation: withValueAt(raw, aid.path, pickResult.queries[0]) }
}

/** The projection-source handler: one pick, plus the entity kind inferred from
 *  the matched element when the author omitted it. */
function sourceStep(
  raw: RawStep,
  aid: SelectionAid,
  parts: Record<string, PartResult> | null,
): SelectionAidResolution {
  const value = selectionAidValue(raw, aid)
  if (!pickOf(value)) return { ok: true, mutation: raw }
  const pickResult = resolvePick(value, parts, selectionAidLabel(raw.type as string, aid), aid.rule)
  if (!pickResult.ok) return pickResult
  // Fill only a missing kind. A present but wrong one (kind: 5) is left for the
  // value rules to refuse rather than silently corrected here, the same refusal
  // the string source form gets.
  const kind = raw.kind === undefined ? projectedKindOf(pickResult.items[0]) : raw.kind
  const resolved = withValueAt(raw, aid.path, pickResult.queries[0])
  return { ok: true, mutation: { ...resolved, kind } }
}

// A pick list keeps the authored order: a string entry is already the stored
// form and passes through, while a selector expands in place to every query it
// matched, deduped so two selectors naming one edge store it once.
function pickListStep(
  raw: RawStep,
  aid: SelectionAid,
  parts: Record<string, PartResult> | null,
): SelectionAidResolution {
  const entries = selectionAidValue(raw, aid)
  if (!Array.isArray(entries)) return { ok: true, mutation: raw }
  const queries: unknown[] = []
  const label = selectionAidLabel(raw.type as string, aid)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    // A string is already the stored form; any other junk is left to the value
    // rules so one boundary keeps the refusal wording.
    if (!pickOf(entry)) {
      queries.push(entry)
      continue
    }
    const pickResult = resolvePick(entry, parts, `${label}[${i}]`, aid.rule)
    if (!pickResult.ok) return pickResult
    for (const query of pickResult.queries) {
      if (!queries.includes(query)) queries.push(query)
    }
  }
  return { ok: true, mutation: withValueAt(raw, aid.path, queries) }
}

/** The catalog sentence naming a setter's selector fields, generated from the
 *  table so a row note cannot promise a field the drive does not resolve. Empty
 *  for a type with no setter row. */
export function selectorSetterNote(type: string): string {
  const fields = selectionAidsFor(type)
    .filter(aid => aid.field !== undefined)
    .map(aid => `\`${aid.field}\``)
  if (fields.length === 0) return ''
  return `The value of ${fields.join(', ')} also takes \`{selector}\` in place of the query string: `
    + 'the headless drive resolves it to the query `select` returned before the edit applies, so the '
    + 'document stores only the query.'
}

/** Rewrite every selector pick in a part mutation into the query string(s) it
 *  matched. A mutation without a selector comes back unchanged, so the caller
 *  can run this on every step. */
export function resolveSelectionAids(
  raw: unknown,
  parts: Record<string, PartResult> | null,
): SelectionAidResolution {
  if (!isRecord(raw) || typeof raw.type !== 'string') return { ok: true, mutation: raw }
  let current = raw
  for (const aid of selectionAidsFor(raw.type)) {
    if (!selectionAidApplies(current, aid)) continue
    // The handler owns one concern: an expandable list, a projection source
    // whose omitted kind is inferred, or a single pick under one rule.
    const resolved = aid.mode === 'list'
      ? pickListStep(current, aid, parts)
      : aid.inferKind === true
        ? sourceStep(current, aid, parts)
        : singleStep(current, aid, parts)
    if (!resolved.ok) return resolved
    current = resolved.mutation as RawStep
  }
  return { ok: true, mutation: current }
}
