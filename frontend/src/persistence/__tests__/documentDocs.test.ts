// Drift guard for docs/document.md, the page that promises to describe the
// part document schema. The doc is checked against the code it documents: a new
// feature kind, constraint or entity cannot ship without its section, and every
// fenced yaml example must be a shape the loader and the JSON Schema accept.
// When this fails, fix the doc, not this file.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import Ajv from 'ajv'
import { CURRENT_DOC_VERSION, loadPartDoc } from '@/persistence/docSchema'
import { PART_DOC_SCHEMA } from '@/persistence/partDocSchema'
import { PORTED_FEATURE_KINDS } from '@/kernel/solverRegistry'
import { CONSTRAINTS } from '@/registry/constraintRegistry'
import { ENTITIES } from '@/registry/entityRegistry'

const DOCS_PATH = join(__dirname, '../../../../docs/document.md')
const DOC = readFileSync(DOCS_PATH, 'utf8')

// ─── doc readers ───

function section(name: string): string {
  const marker = `\n## ${name}\n`
  const start = DOC.indexOf(marker)
  expect(start, `docs/document.md has no "## ${name}" section`).toBeGreaterThanOrEqual(0)
  const rest = DOC.slice(start + marker.length)
  const next = rest.indexOf('\n## ')
  return next === -1 ? rest : rest.slice(0, next)
}

/** The kind names of every `### <kind>` heading, split on `/` so the shared
 *  sections (`### fillet / chamfer`) name both kinds. */
function kindsInHeadings(text: string): string[] {
  const kinds: string[] = []
  for (const match of text.matchAll(/^### (.+)$/gm)) {
    kinds.push(...match[1].split('/').map(k => k.trim()))
  }
  return kinds
}

/** The first-column values of the markdown table with the given header row. */
function tableKinds(header: string): string[] {
  const lines = DOC.split('\n')
  const headerIdx = lines.findIndex(l => l.trim() === header)
  expect(headerIdx, `docs/document.md has no "${header}" table`).toBeGreaterThanOrEqual(0)
  const kinds: string[] = []
  for (let i = headerIdx + 2; i < lines.length; i++) {  // +2 skips the separator row
    const line = lines[i].trim()
    if (!line.startsWith('|')) break
    kinds.push(line.split('|')[1].trim().replace(/^`|`$/g, ''))
  }
  return kinds
}

// ─── feature kinds ───

// `origin` has no solver: it is a builtin repo result, never a solved feature
// (kernel/solverRegistry.ts), but it is a document kind and needs its section.
const DOCUMENT_FEATURE_KINDS: ReadonlySet<string> = new Set([...PORTED_FEATURE_KINDS, 'origin'])

describe('feature kind headings', () => {
  const headings = kindsInHeadings(section('Feature Kinds'))

  it('names no kind the kernel does not dispatch', () => {
    expect(headings.filter(k => !DOCUMENT_FEATURE_KINDS.has(k))).toEqual([])
  })

  it('documents every document kind', () => {
    const documented = new Set(headings)
    expect([...DOCUMENT_FEATURE_KINDS].filter(k => !documented.has(k))).toEqual([])
  })
})

// ─── constraints ───

// `ngon` and `dock` are sugar: written into a sketch, lowered to primitive
// constraints before the solver runs (wasm-kernel/partDocToSketches.ts), so they
// are document kinds without a registry entry.
const CONSTRAINT_SHORTHANDS = ['ngon', 'dock'] as const

describe('constraints table', () => {
  const rows = tableKinds('| kind | description |')

  it('lists every registry constraint and the lowered shorthands', () => {
    const listed = new Set(rows)
    const wanted = [...CONSTRAINTS.map(c => c.kind), ...CONSTRAINT_SHORTHANDS]
    expect(wanted.filter(k => !listed.has(k))).toEqual([])
  })

  it('names no unknown kind', () => {
    const known = new Set<string>([...CONSTRAINTS.map(c => c.kind), ...CONSTRAINT_SHORTHANDS])
    expect(rows.filter(k => !known.has(k))).toEqual([])
  })
})

// ─── entities ───

// `project` is a registry entry for the Project tool's metadata only: the tool
// stores a base-kind entity carrying `source`, never `kind: project`
// (registry/entityRegistry.ts, and the projection note in the doc). `center_rect`
// is the other way around: doc-only sugar the mutation layer expands.
const ENTITY_REGISTRY_ONLY = new Set(['project'])
const ENTITY_DOC_ONLY = new Set(['center_rect'])

describe('entity table', () => {
  const rows = tableKinds('| kind | params | meaning |')

  it('lists every document entity kind in the registry', () => {
    const listed = new Set(rows)
    const wanted = ENTITIES.map(e => e.kind).filter(k => !ENTITY_REGISTRY_ONLY.has(k))
    expect(wanted.filter(k => !listed.has(k))).toEqual([])
  })

  it('names no unknown kind', () => {
    const known = new Set<string>([...ENTITIES.map(e => e.kind), ...ENTITY_DOC_ONLY])
    expect(rows.filter(k => !known.has(k))).toEqual([])
  })
})

// ─── fenced yaml examples ───

const ajv = new Ajv({ allErrors: true })
const validateSchema = ajv.compile(PART_DOC_SCHEMA)

// The per-kind branches, so a failing example is re-validated against its own
// branch and the report names the offending field instead of the whole oneOf
// noise ajv produces for the union.
const FEATURE_BRANCHES = (PART_DOC_SCHEMA.properties as {
  features: { items: { oneOf: Array<Record<string, unknown>> } }
}).features.items.oneOf

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Validator = ReturnType<typeof ajv.compile>

/** ajv's own text omits which property was unexpected; name it. */
function validationText(errors: Validator['errors']): string {
  return (errors ?? [])
    .map(e => {
      const at = e.dataPath || '.'
      const detail = e.keyword === 'additionalProperties'
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : ''
      return `${at} ${e.message ?? e.keyword}${detail}`
    })
    .join('; ')
}

const branchValidators = new Map<string, Validator | null>()

function kindBranchValidator(kind: unknown): Validator | null {
  if (typeof kind !== 'string') return null
  if (branchValidators.has(kind)) return branchValidators.get(kind) ?? null
  const branch = FEATURE_BRANCHES.find(
    b => (b.properties as { kind?: { const?: unknown } } | undefined)?.kind?.const === kind,
  )
  const validator = branch ? ajv.compile(branch) : null
  branchValidators.set(kind, validator)
  return validator
}

/** The schema complaint for `feature` wrapped in `doc`, or '' when the schema
 *  accepts it. */
function schemaFailure(feature: unknown, doc: unknown): string {
  if (validateSchema(doc)) return ''
  const branchValidate = kindBranchValidator(isRecord(feature) ? feature.kind : undefined)
  if (branchValidate && !branchValidate(feature)) {
    return `schema: ${validationText(branchValidate.errors)}`
  }
  return `schema: ${validationText(validateSchema.errors)}`
}

/** Every fenced yaml block in the doc, parsed. A parse error throws here, so a
 *  bad example fails the file; nothing is skipped by shape, and a block whose
 *  first line is a comment is still read. */
function yamlBlocks(): Array<{ text: string; parsed: unknown }> {
  const blocks: Array<{ text: string; parsed: unknown }> = []
  for (const match of DOC.matchAll(/```yaml\n([\s\S]*?)```/g)) {
    blocks.push({ text: match[1], parsed: parseYaml(match[1]) })
  }
  return blocks
}

const YAML_BLOCKS = yamlBlocks()

describe('fenced yaml examples', () => {
  it('is non-empty and holds only document examples and feature lists', () => {
    expect(YAML_BLOCKS.length).toBeGreaterThan(0)
    // A scalar or empty block is a doc bug, not something to skip silently.
    const stray = YAML_BLOCKS.filter(b => !Array.isArray(b.parsed) && !isRecord(b.parsed))
    expect(stray.map(b => b.text.trim())).toEqual([])
  })

  it('pins the document example to the current ladder version', () => {
    const documents = YAML_BLOCKS.filter(b => isRecord(b.parsed))
    expect(documents.length).toBeGreaterThan(0)
    const failures: string[] = []
    for (const { parsed } of documents) {
      const doc = parsed as Record<string, unknown>
      if (doc.version !== CURRENT_DOC_VERSION) {
        failures.push(`version ${JSON.stringify(doc.version)} is not CURRENT_DOC_VERSION ${CURRENT_DOC_VERSION}`)
      }
      if (!validateSchema(parsed)) failures.push(`schema: ${validationText(validateSchema.errors)}`)
    }
    expect(failures).toEqual([])
  })

  // Known gap, not fixable from the doc side: a sigil-less body ref such as
  // `source_body: "extrude1"` passes both validators (`REF` in partDocSchema.ts
  // only bans a leading `$`, and kernel resolveBody accepts the bare spelling),
  // so the guard cannot require the `@` the examples use.
  it('validates every feature example through the loader and the JSON Schema', () => {
    const features = YAML_BLOCKS.flatMap(b => (Array.isArray(b.parsed) ? b.parsed : []))
    expect(features.length).toBeGreaterThan(0)
    const failures: string[] = []
    for (const feature of features) {
      const label = isRecord(feature)
        ? `${String(feature.kind ?? '?')}/${String(feature.id ?? '?')}`
        : JSON.stringify(feature)
      // Stamped at the current ladder version: the examples must be canonical
      // on their face, not healed by a migration on load.
      const doc = { version: CURRENT_DOC_VERSION, kind: 'part', features: [feature] }
      const schema = schemaFailure(feature, doc)
      if (schema) failures.push(`${label} ${schema}`)
      const loaded = loadPartDoc(doc)
      if (!loaded.ok) failures.push(`${label} loader: ${loaded.error.field} ${loaded.error.message}`)
    }
    expect(failures).toEqual([])
  })
})
