// The drive path's strict document check. The browser loader is deliberately
// forward-tolerant (an unknown key passes through, so a newer file opens in an
// older build), but an MCP or CLI caller authoring a document by hand needs the
// opposite: a typo such as `distanse` must be refused by its path rather than
// silently ignored while the solve succeeds. The served JSON Schema is the
// contract, so this checks exactly what it promises.
import { schemaValueProblem } from '@/drive/mutationValues'
import { PART_DOC_SCHEMA } from '@/persistence/partDocSchema'
import { ASSEMBLY_DOC_SCHEMA } from '@/persistence/assemblyDocSchema'
import type { JsonSchema } from '@/persistence/partDocSchema'

// The schema's `pattern` marks a reference that must not carry the `$` sigil,
// but the drive's own mutations store sigil refs (`sketchQuery: '$sk1'` lands as
// `["$sk1"]`) and the loader accepts them, so a document the server just built
// must reload. Strictness here is about shape and unknown keys, not ref spelling.
function withoutPatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutPatterns)
  if (typeof node !== 'object' || node === null) return node
  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'pattern') out[key] = withoutPatterns(value)
  }
  return out
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The schema's features list is a oneOf over per-kind branches, which the
// generic value check does not walk. Pick the branch by the `kind` const.
function featureProblem(feature: unknown, branches: JsonSchema[], label: string): string | null {
  if (!isRecord(feature)) return `${label} must be an object`
  const branch = branches.find(candidate => {
    const kind = (candidate.properties as Record<string, JsonSchema> | undefined)?.kind
    return kind !== undefined && kind.const === feature.kind
  })
  if (branch === undefined) return `${label}.kind ${JSON.stringify(feature.kind)} is not a known feature kind`
  return schemaValueProblem(feature, branch, label)
}

function docProblem(doc: unknown, schema: JsonSchema): string | null {
  if (!isRecord(doc)) return null
  const properties = schema.properties as Record<string, JsonSchema>
  const shell: JsonSchema = {
    ...schema,
    properties: { ...properties, features: { type: 'array' } },
  }
  const top = schemaValueProblem(doc, shell, 'document')
  if (top !== null) return top
  const features = doc.features
  if (!Array.isArray(features)) return null
  const branches = (properties.features.items as JsonSchema).oneOf as JsonSchema[]
  for (let i = 0; i < features.length; i++) {
    const problem = featureProblem(features[i], branches, `features[${i}]`)
    if (problem !== null) return problem
  }
  return null
}

/** The first way a part document breaks the served schema, or null. */
export function partDocStrictProblem(doc: unknown): string | null {
  return docProblem(doc, PART_SCHEMA)
}

/** The first way an assembly document breaks the served schema, or null. */
export function assemblyDocStrictProblem(doc: unknown): string | null {
  return docProblem(doc, ASSEMBLY_SCHEMA)
}

const PART_SCHEMA = withoutPatterns(PART_DOC_SCHEMA) as JsonSchema
const ASSEMBLY_SCHEMA = withoutPatterns(ASSEMBLY_DOC_SCHEMA) as JsonSchema
