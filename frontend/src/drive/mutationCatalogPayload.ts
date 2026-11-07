// The JSON shape the `mutations` tool and the `oversolved://catalog/mutations`
// resource serve. One builder, so a client that reads the resource and one that
// calls the tool cannot see different catalogs.

import type { Mutation } from '@/types/cad'
import { MUTATION_CATALOG, MUTATION_FAMILY, mutationInfoOf, type FieldInfo, type MutationFamily } from '@/drive/mutationCatalog'
import type { JsonSchema } from '@/persistence/partDocSchema'
import { MUTATION_EXAMPLES, type MutationExample } from '@/drive/mutationExamples'
import {
  ASSEMBLY_MUTATION_CATALOG,
  ASSEMBLY_MUTATION_FAMILIES,
  ASSEMBLY_MUTATION_FAMILY,
  assemblyMutationInfoOf,
  type AssemblyFieldInfo,
  type AssemblyMutationFamily,
  type AssemblyWireType,
} from '@/drive/assemblyMutationCatalog'
import { ASSEMBLY_MUTATION_EXAMPLES, type AssemblyMutationExample } from '@/drive/assemblyExamples'

export const MUTATION_CATALOG_URI = 'oversolved://catalog/mutations'

export const MUTATION_FAMILIES: readonly MutationFamily[] = [
  'sketch', 'features', 'picks', 'part style', 'document',
]

export interface CatalogFieldListing {
  type: FieldInfo['type']
  required: boolean
  nullable?: boolean
  note?: string
  // An object field's shape, from the part-document schema.
  shape?: JsonSchema
}

export interface CatalogMutationListing {
  type: Mutation['type']
  summary: string
  note?: string
  fields: Record<string, CatalogFieldListing>
}

export interface MutationCatalogPayload {
  families: Record<MutationFamily, CatalogMutationListing[]>
  examples: MutationExample[]
  // The assembly drive vocabulary, kept beside the part one because the
  // `mutations` tool serves both surfaces.
  assembly: AssemblyCatalogPayload
}

export interface AssemblyCatalogFieldListing {
  type: AssemblyFieldInfo['type']
  required: boolean
  nullable?: boolean
  note?: string
}

export interface AssemblyCatalogMutationListing {
  type: AssemblyWireType
  summary: string
  note?: string
  fields: Record<string, AssemblyCatalogFieldListing>
}

export interface AssemblyCatalogPayload {
  families: Record<AssemblyMutationFamily, AssemblyCatalogMutationListing[]>
  examples: AssemblyMutationExample[]
}

function assemblyCatalogPayload(): AssemblyCatalogPayload {
  const families = Object.fromEntries(
    ASSEMBLY_MUTATION_FAMILIES.map(family => [family, [] as AssemblyCatalogMutationListing[]]),
  ) as Record<AssemblyMutationFamily, AssemblyCatalogMutationListing[]>
  for (const type of Object.keys(ASSEMBLY_MUTATION_CATALOG) as AssemblyWireType[]) {
    const info = assemblyMutationInfoOf(type)
    const fields: Record<string, AssemblyCatalogFieldListing> = {}
    for (const [name, field] of Object.entries(info.fields)) {
      fields[name] = {
        type: field.type,
        required: field.required,
        ...(field.nullable === true && { nullable: true }),
        ...(field.note !== undefined && { note: field.note }),
      }
    }
    families[ASSEMBLY_MUTATION_FAMILY[type]].push({
      type,
      summary: info.summary,
      ...(info.note !== undefined && { note: info.note }),
      fields,
    })
  }
  return {
    families,
    examples: ASSEMBLY_MUTATION_EXAMPLES.map(example => ({ ...example })),
  }
}

/** Every family name the `family` filter accepts, part families first. */
export function catalogFamilyNames(): string[] {
  return [...MUTATION_FAMILIES, ...ASSEMBLY_MUTATION_FAMILIES]
}

export const MUTATION_DETAILS = ['full', 'index'] as const
export type MutationDetail = typeof MUTATION_DETAILS[number]

export interface MutationCatalogFilter {
  kind?: 'part' | 'assembly'
  family?: string
  type?: string | string[]
  detail?: MutationDetail
}

/** One row of the `detail: "index"` reply: enough to choose a type, nothing more. */
export interface CatalogIndexListing {
  type: string
  summary: string
}

export interface FilteredMutationCatalogPayload {
  families?: Partial<Record<MutationFamily, CatalogMutationListing[]>>
  examples?: MutationExample[]
  assembly?: {
    families: Partial<Record<AssemblyMutationFamily, AssemblyCatalogMutationListing[]>>
    examples: AssemblyMutationExample[]
  }
}

export interface IndexedMutationCatalogPayload {
  families?: Partial<Record<MutationFamily, CatalogIndexListing[]>>
  examples?: MutationExample[]
  assembly?: {
    families: Partial<Record<AssemblyMutationFamily, CatalogIndexListing[]>>
    examples: AssemblyMutationExample[]
  }
}

export type FilteredCatalog =
  | { ok: true; payload: FilteredMutationCatalogPayload | IndexedMutationCatalogPayload }
  | { ok: false; error: string }

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return previous[b.length]
}

type CatalogLocation = { kind: 'part' | 'assembly'; family: string }

/** Keep only rows of the named types, or every row when `types` is undefined. */
function narrowFamilies<F extends string, R extends { type: string }>(
  families: Record<F, R[]>,
  names: readonly F[],
  only: readonly string[] | undefined,
  family: string | undefined,
): Partial<Record<F, R[]>> {
  if (family !== undefined && names.includes(family as F)) {
    const rows = families[family as F] ?? []
    const allowed = only === undefined ? undefined : new Set(only)
    return { [family]: allowed === undefined ? [...rows] : rows.filter(row => allowed.has(row.type)) } as Partial<Record<F, R[]>>
  }
  const out = {} as Partial<Record<F, R[]>>
  if (only !== undefined) {
    const wanted = new Set(only)
    for (const fam of names) {
      const rows = (families[fam] ?? []).filter(row => wanted.has(row.type))
      if (rows.length > 0) out[fam] = rows
    }
    return out
  }
  for (const fam of names) out[fam] = [...(families[fam] ?? [])]
  return out
}

/** The index reply: one { type, summary } row per mutation, no notes or fields. */
function indexView(
  payload: FilteredMutationCatalogPayload,
): IndexedMutationCatalogPayload {
  const families: Partial<Record<MutationFamily, CatalogIndexListing[]>> = {}
  for (const fam of MUTATION_FAMILIES) {
    const rows = payload.families?.[fam]
    if (rows !== undefined) families[fam] = rows.map(row => ({ type: row.type, summary: row.summary }))
  }
  const assemblyFamilies: Partial<Record<AssemblyMutationFamily, CatalogIndexListing[]>> = {}
  for (const fam of ASSEMBLY_MUTATION_FAMILIES) {
    const rows = payload.assembly?.families[fam]
    if (rows !== undefined) assemblyFamilies[fam] = rows.map(row => ({ type: row.type, summary: row.summary }))
  }
  return {
    ...(payload.families !== undefined && { families }),
    // The index is for type discovery; examples would carry most of the bytes.
    ...(payload.families !== undefined && { examples: [] }),
    ...(payload.assembly !== undefined && {
      assembly: { families: assemblyFamilies, examples: [] },
    }),
  }
}

/**
 * Narrow the full catalog to a kind, family and/or type, optionally as an index.
 * No filter returns the payload unchanged. A family belongs to one kind, so
 * naming it picks the kind; naming a family of the other kind than `kind` is
 * refused. A type belongs to one family and one kind, so it must agree with
 * both when they are given, and only examples that use a matched type survive.
 */
export function filterMutationCatalog(full: MutationCatalogPayload, filter: MutationCatalogFilter): FilteredCatalog {
  const { kind, family, type, detail = 'full' } = filter
  const partFamilies: readonly string[] = MUTATION_FAMILIES
  const assemblyFamilies: readonly string[] = ASSEMBLY_MUTATION_FAMILIES

  // A row's kind and family come from the served payload, so the filter cannot
  // drift from what the catalog lists.
  const location = new Map<string, CatalogLocation>()
  for (const [fam, rows] of Object.entries(full.families)) {
    for (const row of rows) location.set(row.type, { kind: 'part', family: fam })
  }
  for (const [fam, rows] of Object.entries(full.assembly.families)) {
    for (const row of rows) location.set(row.type, { kind: 'assembly', family: fam })
  }

  const requested = type === undefined ? undefined : [...new Set(Array.isArray(type) ? type : [type])]
  if (requested !== undefined && requested.length === 0) {
    return { ok: false, error: 'field "type" must name at least one mutation type' }
  }
  if (requested !== undefined) {
    for (const name of requested) {
      if (location.has(name)) continue
      // Levenshtein hint, the same mistake-teaching shape select's `type`
      // refusal uses. The valid list itself is what `detail: "index"` serves.
      let best: string | null = null
      let bestDistance = 3
      for (const candidate of location.keys()) {
        const distance = editDistance(name, candidate)
        if (distance < bestDistance) {
          best = candidate
          bestDistance = distance
        }
      }
      const hint = best === null
        ? '; pass detail: "index" to list the valid types'
        : `; did you mean "${best}" (${location.get(best)!.family})?`
      return { ok: false, error: `unknown mutation type "${name}"${hint}` }
    }
  }

  if (family !== undefined) {
    const familyKind = partFamilies.includes(family) ? 'part' : assemblyFamilies.includes(family) ? 'assembly' : null
    const valid = kind === 'part' ? partFamilies : kind === 'assembly' ? assemblyFamilies : catalogFamilyNames()
    if (familyKind === null || (kind !== undefined && familyKind !== kind)) {
      return { ok: false, error: `unknown ${kind ?? ''} family "${family}"; valid families: ${valid.join(', ')}`.replace('  ', ' ') }
    }
  }

  if (requested !== undefined) {
    const kinds = new Set(requested.map(name => location.get(name)!.kind))
    if (kind !== undefined && [...kinds].some(k => k !== kind)) {
      return { ok: false, error: `type does not belong to kind "${kind}": ${requested.join(', ')}` }
    }
    const families = new Set(requested.map(name => location.get(name)!.family))
    if (family !== undefined && [...families].some(f => f !== family)) {
      return { ok: false, error: `type does not belong to family "${family}": ${requested.join(', ')}` }
    }
  }

  const partTypes = requested?.filter(name => location.get(name)!.kind === 'part')
  const assemblyTypes = requested?.filter(name => location.get(name)!.kind === 'assembly')
  // A family picks its own side; without one, a type or kind picks the sides.
  const includePart = kind !== 'assembly' && (
    family !== undefined ? partFamilies.includes(family)
      : requested !== undefined ? partTypes!.length > 0
        : true
  )
  const includeAssembly = kind !== 'part' && (
    family !== undefined ? assemblyFamilies.includes(family)
      : requested !== undefined ? assemblyTypes!.length > 0
        : true
  )

  if (kind === undefined && family === undefined && requested === undefined && detail === 'full') {
    return { ok: true, payload: full }
  }

  const partMatched = requested !== undefined
    ? new Set(partTypes)
    : (family !== undefined && partFamilies.includes(family)
      ? new Set((full.families[family as MutationFamily] ?? []).map(row => row.type))
      : undefined)
  const assemblyMatched = requested !== undefined
    ? new Set(assemblyTypes)
    : (family !== undefined && assemblyFamilies.includes(family)
      ? new Set((full.assembly.families[family as AssemblyMutationFamily] ?? []).map(row => row.type))
      : undefined)

  const payload: FilteredMutationCatalogPayload = {}
  if (includePart) {
    payload.families = narrowFamilies(full.families, MUTATION_FAMILIES, partTypes, family)
    payload.examples = full.examples
      .filter(example => partMatched === undefined || example.steps.some(step => 'mutation' in step && partMatched.has(step.mutation.type)))
      .map(example => ({ ...example }))
  }
  if (includeAssembly) {
    payload.assembly = {
      families: narrowFamilies(full.assembly.families, ASSEMBLY_MUTATION_FAMILIES, assemblyTypes, family),
      examples: full.assembly.examples
        .filter(example => assemblyMatched === undefined || example.steps.some(step => assemblyMatched.has(step.mutation.type)))
        .map(example => ({ ...example })),
    }
  }

  return { ok: true, payload: detail === 'index' ? indexView(payload) : payload }
}

/** The visible catalog grouped by family, plus the runnable examples. */
export function mutationCatalogPayload(): MutationCatalogPayload {
  const families = Object.fromEntries(
    MUTATION_FAMILIES.map(family => [family, [] as CatalogMutationListing[]]),
  ) as Record<MutationFamily, CatalogMutationListing[]>
  for (const type of Object.keys(MUTATION_CATALOG) as Mutation['type'][]) {
    const info = mutationInfoOf(type)
    if (info.hidden === true) continue
    const fields: Record<string, CatalogFieldListing> = {}
    for (const [name, field] of Object.entries(info.fields)) {
      // The listing is the external vocabulary: internal plumbing stays out of
      // it even when its row has to carry the field for the type check.
      if (field.internal === true) continue
      fields[name] = {
        type: field.type,
        required: field.required,
        ...(field.nullable === true && { nullable: true }),
        ...(field.note !== undefined && { note: field.note }),
        ...(field.shape !== undefined && { shape: field.shape }),
      }
    }
    families[MUTATION_FAMILY[type]].push({
      type,
      summary: info.summary,
      ...(info.note !== undefined && { note: info.note }),
      fields,
    })
  }
  return {
    families,
    examples: MUTATION_EXAMPLES.map(example => ({ ...example })),
    assembly: assemblyCatalogPayload(),
  }
}
