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
