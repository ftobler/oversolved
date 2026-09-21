import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { readWorkspaceMeta, writeWorkspaceMeta } from './idbCarrier'
import { getWorkspaceStore, type WorkspaceStore } from './store'
import { randomUuid } from '@/utils/randomUuid'

// Before the uuid-keyed file registry (71fa457a), an `import_step` feature
// carried its STEP file as inline base64 under `file_data`. The registry landed
// with no migration on the theory that such a document was disposable (A2, and
// the v3 note in stores/documentStore/idb.ts). It was not: a real library
// carries them, and each one is a document that exports as tens of megabytes of
// base64 AND cannot solve at all, because solveImportStep refuses a non-empty
// `file_data` by name before it looks at anything else.
//
// This is that missing migration. It rewrites such a document into the shape a
// fresh STEP import already produces: the bytes become a workspace file entry
// and the feature keeps only `file_id`. Nothing else about the document moves.

export const INLINE_STEP_MIGRATION = 'inline-step-payloads'

export interface LiftedStepFile {
  fileId: string
  name: string
  bytes: Uint8Array
}

export interface LiftedDocument {
  text: string
  files: LiftedStepFile[]
  // Feature ids whose payload did not decode. Their features are left exactly
  // as they were, so the kernel keeps refusing them loudly instead of solving
  // against bytes that are not a STEP file.
  undecodable: string[]
}

// YAML wraps a long scalar, and the line breaks come back as spaces, so the
// payload is only base64 once the whitespace is out of it.
function decodeBase64(payload: string): Uint8Array | undefined {
  try {
    const binary = atob(payload.replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return undefined
  }
}

// A STEP file entry is a file on disk once exported, so it is named like one.
function stepFileName(feature: Record<string, unknown>, featureId: string): string {
  const label = typeof feature.label === 'string' && feature.label ? feature.label : featureId
  return /\.(step|stp)$/i.test(label) ? label : `${label}.step`
}

/**
 * The pure half: a document's text in, the rewritten text plus the files it
 * gave up out. Null when there is nothing to lift, which is the common case and
 * lets the caller skip the write entirely.
 *
 * A feature that already names a `file_id` keeps it and the bytes are stored
 * under that same id, so a half-migrated document converges instead of minting
 * a second copy of its own file.
 */
export function liftInlineStepPayloads(
  text: string,
  mintId: () => string = randomUuid,
): LiftedDocument | null {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const doc = raw as Record<string, unknown>
  const features = doc.features
  if (!Array.isArray(features)) return null

  const files: LiftedStepFile[] = []
  const undecodable: string[] = []
  for (const candidate of features) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue
    const feature = candidate as Record<string, unknown>
    if (feature.kind !== 'import_step') continue
    const payload = feature.file_data
    if (typeof payload !== 'string' || payload.length === 0) continue
    const featureId = typeof feature.id === 'string' ? feature.id : ''
    const bytes = decodeBase64(payload)
    if (bytes === undefined) {
      undecodable.push(featureId)
      continue
    }
    const existing = feature.file_id
    const fileId = typeof existing === 'string' && existing ? existing : mintId()
    files.push({ fileId, name: stepFileName(feature, featureId), bytes })
    feature.file_id = fileId
    delete feature.file_data
  }
  if (files.length === 0 && undecodable.length === 0) return null
  return { text: stringifyYaml(doc), files, undecodable }
}

export interface InlineStepMigrationReport {
  // True when the workspace was already marked, so nothing was read or written.
  skipped: boolean
  documents: number
  files: number
  bytes: number
  // `<document name>/<feature id>` per payload that did not decode.
  undecodable: string[]
}

async function hasEntry(workspace: string, id: string, store: WorkspaceStore): Promise<boolean> {
  try {
    await store.readEntry(workspace, id)
    return true
  } catch {
    return false
  }
}

/**
 * The workspace half: heal every document in one workspace, once. The marker
 * rides on the workspace meta so a reopen costs one meta read instead of a read
 * of every document's payload.
 *
 * Trashed documents are migrated too: their payloads are still serialized into
 * an export, which is half of what makes one huge.
 */
export async function migrateInlineStepPayloads(
  workspace: string,
  store: WorkspaceStore = getWorkspaceStore(),
): Promise<InlineStepMigrationReport> {
  const report: InlineStepMigrationReport = {
    skipped: false, documents: 0, files: 0, bytes: 0, undecodable: [],
  }
  const meta = await readWorkspaceMeta(workspace)
  // No meta is no workspace. Marking one into existence here would write a row
  // the store never created.
  if (!meta) return { ...report, skipped: true }
  if (meta.migrations?.includes(INLINE_STEP_MIGRATION)) return { ...report, skipped: true }

  for (const row of await store.listEntries(workspace, { includeTrashed: true })) {
    if (row.kind !== 'document') continue
    const entry = await store.readEntry(workspace, row.id)
    // The substring test costs nothing against a payload already in hand and
    // spares a YAML parse of every healthy document in the library.
    if (entry.text === undefined || !entry.text.includes('file_data')) continue
    const lifted = liftInlineStepPayloads(entry.text)
    if (lifted === null) continue

    // Files first. An interrupted run then leaves an unreferenced file entry,
    // which is inert, rather than a document pointing at a file that is not
    // there, which is a broken reference.
    for (const file of lifted.files) {
      if (!await hasEntry(workspace, file.fileId, store)) {
        await store.addEntry(workspace, {
          id: file.fileId,
          kind: 'file',
          name: file.name,
          mime: 'application/step',
          fileKind: 'step',
          bytes: file.bytes,
        })
      }
      report.files++
      report.bytes += file.bytes.byteLength
    }
    for (const featureId of lifted.undecodable) report.undecodable.push(`${entry.name}/${featureId}`)
    // A document that gave up nothing is left byte-identical, so it keeps its
    // rev and does not grow a dirty dot for a rewrite that changed nothing.
    if (lifted.files.length === 0) continue
    await store.writeEntry(workspace, { ...entry, text: lifted.text })
    report.documents++
  }

  // Re-read before stamping. The writes above went through the store, which
  // reconciles each document's reference edges onto this same meta row, so
  // stamping the snapshot taken at the top would erase every edge the
  // migration just created.
  const stamped = await readWorkspaceMeta(workspace) ?? meta
  await writeWorkspaceMeta({
    ...stamped,
    migrations: [...(stamped.migrations ?? []), INLINE_STEP_MIGRATION],
  })
  return report
}
