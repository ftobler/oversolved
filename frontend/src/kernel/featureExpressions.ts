// Expression-param resolution before leaf dispatch. Split out of
// solverRegistry so a leaf that re-solves an earlier feature (the pattern
// leaf) can resolve that feature's expressions without importing the dispatch
// table that owns it.

import type { FeatureKind, PartFeature } from '@/types/cad'
import { nestedFeatureParams } from './features/shared/featureParams'
import { evalFeatureParams, EXPR_FIELDS_BY_KIND, isExprFieldKind, type ExprFieldKind } from './evalExpr'

type FeatureOf<K extends FeatureKind> = Extract<PartFeature, { kind: K }>

/**
 * Where each kind's expression-capable params live. Most kinds nest them under
 * `feature[kind]`; `plane` keeps them in `feature.definition`; `import_step`
 * reads `scale` straight off the feature. An empty string means feature-level.
 * Each value is pinned to a key of that kind's payload, so a mistyped sub-key
 * cannot survive a rename of the def field it names.
 */
type ExprSubKey<K extends ExprFieldKind> = '' | Extract<keyof FeatureOf<K>, string>

const EXPR_SUBKEY_BY_KIND: { [K in ExprFieldKind]: ExprSubKey<K> } = {
  extrude: 'extrude',
  revolve: 'revolve',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  move_face: 'move_face',
  hole: 'hole',
  pattern: 'pattern',
  transform: 'transform',
  plane: 'definition',
  helix: 'helix',
  import_step: '',
  boolean: 'boolean',
}

/**
 * Resolve any expression-string params on a feature to numbers before the leaf
 * solver runs. A feature is canonicalized first: every flat param is folded into
 * the sub-dict (flat wins, the same rule the loader migration applies), so the
 * one target evaluated is the sub-dict (the feature itself for `import_step`,
 * whose `scale` is feature-level by design). Returns a shallow copy with the
 * sub-dict cloned and evaluated; the original feature (and the document) keeps
 * its raw expression strings. Plain-number fields are untouched, so legacy docs
 * cost nothing.
 *
 * On a failed evaluation the leaf solver is never reached: an `exception`
 * result is returned carrying the parse message. `context` supplies named
 * variables from the features before this one.
 */
export function resolveFeatureExpressions(
  feature: Record<string, unknown>,
  context: Record<string, number> = {},
  laterVariables: Record<string, number> = {},
): { feature: Record<string, unknown> } | { exception: string } {
  const kind = feature.kind as string | undefined
  if (!kind) return { feature }
  if (!isExprFieldKind(kind)) return { feature }
  const exprFields = EXPR_FIELDS_BY_KIND[kind]

  const { feature: canonical } = nestedFeatureParams(feature)
  const subKey = EXPR_SUBKEY_BY_KIND[kind]
  const copy: Record<string, unknown> = { ...canonical }
  const target: Record<string, unknown> = subKey === ''
    ? copy
    : (copy[subKey] = { ...(copy[subKey] as Record<string, unknown> | undefined) })

  evalFeatureParams(target, exprFields, context, laterVariables)

  const errKey = Object.keys(target).find((k) => k.endsWith('_error'))
  if (errKey) return { exception: String(target[errKey]) }

  return { feature: copy }
}
