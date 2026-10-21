// The JSON shape the `mutations` tool and the `oversolved://catalog/mutations`
// resource serve. One builder, so a client that reads the resource and one that
// calls the tool cannot see different catalogs.

import type { Mutation } from '@/types/cad'
import { MUTATION_CATALOG, MUTATION_FAMILY, mutationInfoOf, type FieldInfo, type MutationFamily } from '@/drive/mutationCatalog'
import { MUTATION_EXAMPLES, type MutationExample } from '@/drive/mutationExamples'

export const MUTATION_CATALOG_URI = 'oversolved://catalog/mutations'

export const MUTATION_FAMILIES: readonly MutationFamily[] = [
  'sketch', 'features', 'picks', 'part style', 'document',
]

export interface CatalogFieldListing {
  type: FieldInfo['type']
  required: boolean
  note?: string
}

export interface CatalogMutationListing {
  type: Mutation['type']
  summary: string
  fields: Record<string, CatalogFieldListing>
}

export interface MutationCatalogPayload {
  families: Record<MutationFamily, CatalogMutationListing[]>
  examples: MutationExample[]
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
        ...(field.note !== undefined && { note: field.note }),
      }
    }
    families[MUTATION_FAMILY[type]].push({ type, summary: info.summary, fields })
  }
  return { families, examples: MUTATION_EXAMPLES.map(example => ({ ...example })) }
}
