// The local crash reports: stack, build identity, the live document snapshot
// and the session's replayable mutation tail, written to IndexedDB by the
// error paths (window errors, unhandled rejections, worker traps, the editor
// error boundary). Nothing is sent anywhere; the reports page exports one as a
// zip so a bug report can carry the exact state and a replay.
//
// The replayable half is the command journal's repro, borrowed wholesale: its
// baseline doc chains to every entry, so a report replays from the payload
// alone. The journal ring is bounded (JOURNAL_CAPACITY), which is the "last N
// mutations" the report carries; trimming the entries further would break the
// chain from the baseline and make the payload unreplayable.
import { stringify as stringifyYaml } from 'yaml'
import JSZip from 'jszip'
import type { PartDoc } from '@/types/cad'
import { docHashOf } from '@/drive/docHash'
import { snapshotJson, type ReproPayload } from '@/drive/journal'
import { randomUuid } from '@/utils/randomUuid'
import { recoveryEditorSnapshot, type EditorSnapshot } from '@/recovery/autosave'
import { APP_VERSION } from '@/recovery/version'
import {
  STORE_CRASH_REPORTS,
  idbDeleteFrom,
  idbGetAllFrom,
  idbPutTo,
} from '@/stores/documentStore/idb'

export type CrashSource = 'error' | 'rejection' | 'worker' | 'boundary'

export interface CrashReportRecord {
  version: 1
  id: string
  at: number
  source: CrashSource
  message: string
  stack: string | null
  appVersion: string
  docId: string | null
  workspace: string | null
  docName: string | null
  // docHashOf(doc): a reader can check the snapshot before trusting it.
  docHash: string | null
  doc: PartDoc | null
  repro: ReproPayload | null
}

// The newest reports kept; older ones are trimmed on write so a crash loop
// cannot grow the store without bound.
export const CRASH_REPORT_LIMIT = 20

// An identical failure repeating inside this window is one crash, not a storm:
// a worker that traps on every drag tick, or an error thrown from a render
// loop, would otherwise fill the store with copies of one event.
export const CRASH_DEDUPE_MS = 10_000

export interface CrashReportInput {
  source: CrashSource
  message: string
  stack?: string | null
  at?: number
  // The live editor facts. Omitted means read the registered editor; null
  // (explicitly) records without one, which is what a test wants.
  snapshot?: EditorSnapshot | null
}

let lastSignature: string | null = null
let lastSignatureAt = 0

// The message and stack of anything that can be thrown or emitted. Handles the
// shapes that actually reach the handlers: an Error, a rejected string, a
// window/worker ErrorEvent (whose own `.error` may be null cross-origin, so its
// message and location are the fallback), and a promise rejection event
// (unwrapped through `.reason`).
export function errorParts(value: unknown): { message: string; stack: string | null } {
  if (value instanceof Error) return { message: value.message, stack: value.stack ?? null }
  if (typeof value === 'string') return { message: value, stack: null }
  if (value && typeof value === 'object') {
    const e = value as {
      message?: unknown
      stack?: unknown
      filename?: unknown
      lineno?: unknown
      error?: unknown
      reason?: unknown
    }
    if (e.error instanceof Error) return { message: e.error.message, stack: e.error.stack ?? null }
    if (typeof e.message === 'string' && e.message !== '') {
      const location = typeof e.filename === 'string' && e.filename !== ''
        ? ` (${e.filename}${typeof e.lineno === 'number' ? `:${e.lineno}` : ''})`
        : ''
      return {
        message: `${e.message}${location}`,
        stack: typeof e.stack === 'string' ? e.stack : null,
      }
    }
    if (e.reason !== undefined && e.reason !== value) return errorParts(e.reason)
  }
  return { message: String(value), stack: null }
}

/**
 * Record one crash. Never throws: the caller is already on a failure path, so
 * a failing report write is logged and dropped rather than escalated. Returns
 * the record on success, null when the write failed, the platform has no local
 * database at all (a test environment), or the failure is a repeat inside the
 * dedupe window.
 */
export async function recordCrashReport(input: CrashReportInput): Promise<CrashReportRecord | null> {
  const at = input.at ?? Date.now()
  const signature = `${input.source}:${input.message}:${input.stack ?? ''}`
  if (signature === lastSignature && at - lastSignatureAt < CRASH_DEDUPE_MS) return null
  lastSignature = signature
  lastSignatureAt = at

  const facts = input.snapshot === undefined ? recoveryEditorSnapshot() : input.snapshot
  const doc = facts?.doc ?? null
  const record: CrashReportRecord = {
    version: 1,
    id: randomUuid(),
    at,
    source: input.source,
    message: input.message,
    stack: input.stack ?? null,
    appVersion: APP_VERSION,
    docId: facts?.docId ?? null,
    workspace: facts?.workspace ?? null,
    docName: facts?.docName ?? null,
    docHash: doc ? docHashOf(doc) : null,
    doc: doc ? snapshotJson(doc) : null,
    repro: facts?.repro ? snapshotJson(facts.repro) : null,
  }
  if (typeof indexedDB === 'undefined') return null
  try {
    await idbPutTo(STORE_CRASH_REPORTS, record)
    await trimCrashReports()
  } catch (e) {
    console.error('[recovery] could not record the crash report:', e)
    return null
  }
  return record
}

/** Record a worker trap. Called from the worker clients' onerror hooks. */
export function noteWorkerError(name: string, event: unknown): void {
  const parts = errorParts(event)
  void recordCrashReport({ source: 'worker', message: `${name}: ${parts.message}`, stack: parts.stack })
}

/** Every report, newest first. */
export async function listCrashReports(): Promise<CrashReportRecord[]> {
  const all = await idbGetAllFrom<CrashReportRecord>(STORE_CRASH_REPORTS)
  return all.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
}

export async function deleteCrashReport(id: string): Promise<void> {
  await idbDeleteFrom(STORE_CRASH_REPORTS, id)
}

// Drop everything beyond the newest CRASH_REPORT_LIMIT.
async function trimCrashReports(): Promise<void> {
  const all = await listCrashReports()
  for (const report of all.slice(CRASH_REPORT_LIMIT)) await deleteCrashReport(report.id)
}

/**
 * One report as a zip: the record JSON, the document snapshot as YAML for
 * human reading, and the repro JSON for replaying. A report with no document
 * open when it crashed carries just the record. Bytes rather than a Blob so
 * the builder is testable headlessly; the download wraps them.
 */
export async function buildCrashReportZip(report: CrashReportRecord): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('crash-report.json', JSON.stringify(report, null, 2) + '\n')
  if (report.doc) zip.file('document.yaml', stringifyYaml(report.doc))
  if (report.repro) zip.file('repro.json', JSON.stringify(report.repro, null, 1) + '\n')
  return zip.generateAsync({ type: 'uint8array' })
}

// The download name: when it happened, then the source, so a maintainer can
// sort a folder of them at a glance.
export function crashReportFilename(report: CrashReportRecord, date = new Date(report.at)): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  return `oversolved-crash-${stamp}-${report.source}.zip`
}
