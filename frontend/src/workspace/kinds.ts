import { parse as parseYaml } from 'yaml'
import type { WorkspaceEntry } from './types'

export const KNOWN_DOC_KINDS = ['part', 'assembly'] as const
export type KnownDocKind = (typeof KNOWN_DOC_KINDS)[number]

export type InterpretedEntry =
  | { ok: true; docKind: KnownDocKind }
  | { ok: false; reason: 'unsupported-doc-kind'; docKind: string }
  | { ok: false; reason: 'missing-doc-kind' }
  | { ok: false; reason: 'not-a-document' }

type EntryKindView = Pick<WorkspaceEntry, 'kind' | 'name' | 'docKind'>

// Reads the top-level `kind` field as a string and never coerces. Absent,
// non-string, empty and unparseable all read as "no kind".
export function parseDocKind(text: string): string | undefined {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const kind = (raw as Record<string, unknown>).kind
  if (typeof kind !== 'string' || kind.length === 0) return undefined
  return kind
}

// TEMPORARY, and only for a loose payload the adoption classifier is handed.
// A document's kind lives in the manifest, never in the payload, so nothing
// ever writes a top-level `kind` into the text: the YAML export (PartExportImport)
// stringifies the doc verbatim, and every exported `.yaml` therefore comes back
// kind-less and reads as a plain file. Until the export stamps the kind, a
// kind-less payload is recognized by its shape. Deliberately narrow: a mapping
// whose `features` is a non-empty list of `{id, kind}` mappings, which no
// non-document YAML the app handles looks like. An assembly is the one that
// places or mates parts; a doc holding only built-ins is indistinguishable and
// reads as a part, which is the empty-document case either way.
export function inferDocKind(text: string): KnownDocKind | undefined {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record.kind !== undefined) return undefined  // a stamped kind is parseDocKind's answer, not this one's
  const features = record.features
  if (!Array.isArray(features) || features.length === 0) return undefined
  let assembly = false
  for (const feature of features) {
    if (typeof feature !== 'object' || feature === null || Array.isArray(feature)) return undefined
    const row = feature as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.kind !== 'string') return undefined
    if (row.kind === 'part_instance' || row.kind === 'mate') assembly = true
  }
  return assembly ? 'assembly' : 'part'
}

// The single gate that turns an entry into an interpreted document. Every
// loader, picker and editor routes through this (I6). Missing is refused too:
// the legacy part default is a pre-branch convenience A2 retires.
export function interpretEntry(entry: EntryKindView): InterpretedEntry {
  if (entry.kind !== 'document') return { ok: false, reason: 'not-a-document' }
  if (entry.docKind === undefined) return { ok: false, reason: 'missing-doc-kind' }
  if ((KNOWN_DOC_KINDS as readonly string[]).includes(entry.docKind)) {
    return { ok: true, docKind: entry.docKind as KnownDocKind }
  }
  return { ok: false, reason: 'unsupported-doc-kind', docKind: entry.docKind }
}

// Names the entry by its display name, states the offending kind verbatim, and
// never substitutes part. Thrown as Error(refusalMessage(entry, result)).
export function refusalMessage(entry: EntryKindView, result: Extract<InterpretedEntry, { ok: false }>): string {
  if (result.reason === 'not-a-document') return `Entry '${entry.name}' is not a document`
  if (result.reason === 'missing-doc-kind') return `Document '${entry.name}' has no kind`
  return `Document '${entry.name}' has unsupported kind '${result.docKind}'`
}
