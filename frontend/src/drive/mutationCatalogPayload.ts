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
