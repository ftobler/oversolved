// The one carry decision shared by pattern_entities and the sketch clipboard.
// A copied entity set keeps the constraints that live entirely inside it: its
// internal shape survives a copy, while every anchor to something outside (the
// origin, a part edge, a plane, another entity) is dropped, because the copy is
// free-floating. The two callers differ in exactly one row of the table: a
// pattern keeps `fixed` (and transforms its override), while a clipboard copy
// breaks it, per the user's "any fixed constraint" rule.
//
// Operands are resolved once to the source each names plus its vertex suffix,
// so a caller that re-homes the set (a pattern instance, a paste) only
// substitutes ids. The constraint itself is never edited here.

import type { PartConstraint } from '@/types/cad'
import { warn, CONSTRAINT_REF_FIELDS } from './helpers'
import { isVertexPointKey } from '@/types/vertexKeys'
import { CARRY_KINDS } from './sketchMirror'

export type CarryPolicy = 'pattern' | 'copy'

/** One operand of a carried constraint, resolved to the copied entity it names. */
export interface CarryOperand {
  field: keyof PartConstraint
  sourceId: string
  key: string
  // The stored ref's own leading `$`, if any, so a clone is spelled like its
  // source rather than normalising every operand.
  prefix: string
}

/** One constraint the copies may carry, with its operands resolved. */
export interface CarryTemplate {
  constraint: PartConstraint
  // A group has no single-ref field: each member is one entry of `refs`, in
  // anchor-first order.
  groupRefs?: CarryOperand[]
  operands: CarryOperand[]
}

/** What a copy-policy call could not carry, counted by reason for the toast. */
export interface CarryReport {
  // `fixed` rows dropped because the user asked for a free-floating copy.
  fixed: number
  // A constraint that reaches anything outside the set: the origin, a part or
  // plane ref, another entity, or a projection source.
  outside: number
}

export interface CarryResult {
  templates: CarryTemplate[]
  report: CarryReport
}

/** Which source a stored operand names, with its vertex suffix, or null when
 *  it names anything else (another feature, an entity outside the set). A bare
 *  id is accepted beside the document's `$` local spelling because a clipboard
 *  clip is authored text, not a stored document row. */
function operandSource(
  ref: string,
  sourceIds: readonly string[],
): { sourceId: string; key: string; prefix: string } | null {
  if (ref.startsWith('@')) return null
  const prefix = ref.startsWith('$') ? ref.slice(0, 1) : ''
  const part = ref.slice(prefix.length)
  for (const id of sourceIds) {
    if (part === id) return { sourceId: id, key: '', prefix }
    // Exact id plus a known vertex suffix, as refMatchesEntity reads it, so
    // `l10` is never taken for a vertex of `l1`.
    if (part.startsWith(id) && isVertexPointKey(part.slice(id.length))) {
      return { sourceId: id, key: part.slice(id.length), prefix }
    }
  }
  return null
}

/** True when at least one of a group's member refs names a copied entity. A
 *  group wholly outside the set is unrelated to the copy and is not reported. */
function groupTouchesSet(refs: readonly unknown[], sourceIds: readonly string[]): boolean {
  return refs.some(ref => typeof ref === 'string' && operandSource(ref, sourceIds) !== null)
}

/**
 * The constraints a copy of `sourceIds` may carry, under one of the two
 * policies. `label` prefixes the dev warnings (the calling mutation's name);
 * the clipboard copy passes null and reports counts instead, because a paste is
 * a user action rather than a silent authoring step.
 */
export function carryConstraints(
  constraints: readonly PartConstraint[],
  sourceIds: readonly string[],
  policy: CarryPolicy,
  label: string | null,
): CarryResult {
  const templates: CarryTemplate[] = []
  const report: CarryReport = { fixed: 0, outside: 0 }
  const say = (message: string, detail: { id: string; kind?: string }): void => {
    if (label !== null) warn(`${label}: ${message}`, detail)
  }
  const copy = policy === 'copy'

  for (const c of constraints) {
    // A projection holds an entity to a shape outside the sketch, so its
    // anchoring never travels; the copy keeps the entity at its solved shape.
    if (c.kind === 'projection') {
      if (copy && typeof c.target === 'string' && operandSource(c.target, sourceIds) !== null) {
        report.outside++
      }
      continue
    }

    // A group copies as one group over its members, and only when every member
    // is copied. A member may be a whole entity or one point of one.
    if (c.kind === 'group') {
      const refs = Array.isArray(c.refs) ? c.refs : []
      const groupRefs: CarryOperand[] = []
      let outside = refs.length === 0
      for (const ref of refs) {
        const hit = typeof ref === 'string' ? operandSource(ref, sourceIds) : null
        if (hit === null) { outside = true; break }
        groupRefs.push({ ...hit, field: 'refs' })
      }
      if (outside) {
        say('group has a member outside the source set, left on the source', { id: c.id })
        if (copy && groupTouchesSet(refs, sourceIds)) report.outside++
        continue
      }
      templates.push({ constraint: c, operands: [], groupRefs })
      continue
    }

    const operandFields = CONSTRAINT_REF_FIELDS.filter(f => typeof c[f] === 'string')
    if (operandFields.length === 0) {
      // A refs-only sugar constraint (ngon) has no single-ref operand to map;
      // say so when it reaches a source, as the mirror does.
      const refs = Array.isArray(c.refs) ? c.refs : []
      if (refs.some(ref => typeof ref === 'string' && operandSource(ref, sourceIds) !== null)) {
        say('n-ary (sugar) constraint dropped', { id: c.id, kind: c.kind })
        if (copy) report.outside++
      }
      continue
    }

    const operands: CarryOperand[] = []
    let outside = false
    for (const field of operandFields) {
      const hit = operandSource(c[field] as string, sourceIds)
      if (hit === null) { outside = true; break }
      operands.push({ field, ...hit })
    }
    // A constraint that names no source at all is not this copy's business;
    // only one that straddles the set and the rest of the sketch is reported.
    if (outside) {
      if (operands.length > 0) {
        say('constraint reaches outside the source set, left on the source', { id: c.id, kind: c.kind })
        if (copy) {
          if (c.kind === 'fixed') report.fixed++
          else report.outside++
        }
      }
      continue
    }
    if (!CARRY_KINDS.has(c.kind)) {
      say('constraint kind carries no copied form, dropped', { id: c.id, kind: c.kind })
      continue
    }
    if (Array.isArray(c.refs) && c.refs.length > 0) {
      say('n-ary (sugar) constraint dropped', { id: c.id, kind: c.kind })
      if (copy) report.outside++
      continue
    }
    if (copy && c.kind === 'fixed') {
      report.fixed++
      continue
    }
    templates.push({ constraint: c, operands })
  }
  return { templates, report }
}
