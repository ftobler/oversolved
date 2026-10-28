// Canonical feature-parameter storage. A feature's non-base params live in its
// sub-def: the field named after its kind (`extrude: {...}`), `definition` for a
// plane. Flat params on the feature are legacy input. types/cad.ts's union is
// the type; this is the runtime key table the loader migration and the solver
// adapter share, so the two cannot disagree about where a param lives.

import type { FeatureKind, PartFeature } from '@/types/cad'

type Dict = Record<string, unknown>

type FeatureOf<K extends FeatureKind> = Extract<PartFeature, { kind: K }>

/** The base fields FeatureBase owns; they stay flat on every feature. */
export const FEATURE_BASE_KEYS: ReadonlySet<string> = new Set([
  'id', 'kind', 'label', 'visible', 'suppressed',
])

/**
 * kind -> sub-def key. A kind absent here keeps every param feature-level
 * (sketch's entities/initial/constraints/plane, import_step's file_id/scale,
 * origin). The `satisfies` pins each value to a real payload key of that kind,
 * so a renamed def field fails to compile instead of a param silently never
 * being read.
 */
export const FEATURE_DEF_SUBKEY = {
  extrude: 'extrude',
  revolve: 'revolve',
  sweep: 'sweep',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  boolean: 'boolean',
  array: 'array',
  circular_array: 'circular_array',
  delete_body: 'delete_body',
  hole: 'hole',
  transform: 'transform',
  mirror: 'mirror',
  split: 'split',
  variable: 'variable',
  helix: 'helix',
  plane: 'definition',
} as const satisfies { [K in FeatureKind]?: Extract<keyof FeatureOf<K>, string> }

export type SubDefKind = keyof typeof FEATURE_DEF_SUBKEY

function isRecord(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface NestedFeatureParams {
  /** A feature with every flat param folded into its sub-def. The SAME object
   *  when there was nothing to fold, so a caller can skip a rewrite by identity. */
  feature: Dict
  /** `kind.field` names whose nested value was shadowed by the flat one and
   *  dropped, for the migration log. */
  dropped: string[]
}

/**
 * Move every non-base flat field into the feature's sub-def. Flat wins on
 * conflict (matching the leaf solvers' old `{ ...sub, ...feature }` overlay), so
 * folding changes no geometry; the shadowed nested value is reported in
 * `dropped`. Pure: never mutates the input. A kind with no sub-def, or one with
 * nothing flat, is returned unchanged by identity.
 */
export function nestedFeatureParams(feature: Dict): NestedFeatureParams {
  const kind = feature.kind
  const subKey = typeof kind === 'string' ? FEATURE_DEF_SUBKEY[kind as SubDefKind] : undefined
  if (subKey === undefined) return { feature, dropped: [] }

  const flatKeys = Object.keys(feature).filter(k => !FEATURE_BASE_KEYS.has(k) && k !== subKey)
  if (flatKeys.length === 0) return { feature, dropped: [] }

  const existing = feature[subKey]
  const sub: Dict = isRecord(existing) ? { ...existing } : {}
  const out: Dict = { ...feature }
  const dropped: string[] = []
  for (const key of flatKeys) {
    if (key in sub && !valuesEqual(sub[key], feature[key])) dropped.push(`${kind}.${key}`)
    sub[key] = feature[key]
    delete out[key]
  }
  out[subKey] = sub
  return { feature: out, dropped }
}
