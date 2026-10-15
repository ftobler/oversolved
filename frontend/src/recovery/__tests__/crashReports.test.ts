//
// The crash report store: the snapshot and repro round-trip, identical crashes
// dedupe into one record, the store is capped, the zip carries the report and
// its replayable payload, and a worker ErrorEvent is folded into a message.
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import JSZip from 'jszip'
import {
  CRASH_DEDUPE_MS,
  CRASH_REPORT_LIMIT,
  buildCrashReportZip,
  crashReportFilename,
  deleteCrashReport,
  errorParts,
  listCrashReports,
  noteWorkerError,
  recordCrashReport,
  type CrashReportInput,
} from '@/recovery/crashReports'
import type { EditorSnapshot } from '@/recovery/autosave'
import { docHashOf } from '@/drive/docHash'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { resetDbConnection } from '@/stores/documentStore/idb'
import type { PartDoc } from '@/types/cad'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

beforeEach(freshDb)

function snapshot(doc: PartDoc | null): EditorSnapshot {
  return { docId: 'doc-1', workspace: 'ws-1', docName: 'Bracket', doc, repro: null }
}

async function record(overrides: Partial<CrashReportInput> & { message: string }) {
  return recordCrashReport({ source: 'boundary', ...overrides })
}

describe('crash reports', () => {
  it('records the stack, build identity, doc snapshot and hash', async () => {
    const doc = makeDoc(makeSketch('sk1'))
    const written = await record({
      message: 'render exploded',
      stack: 'Error: render exploded\n  at Part',
      snapshot: snapshot(doc),
      at: 1000,
    })

    expect(written).not.toBeNull()
    const [read] = await listCrashReports()
    expect(read).toMatchObject({
      source: 'boundary',
      message: 'render exploded',
      stack: 'Error: render exploded\n  at Part',
      docId: 'doc-1',
      workspace: 'ws-1',
      docName: 'Bracket',
    })
    expect(read.appVersion).toBeTruthy()
    expect(read.doc).toEqual(doc)
    expect(read.docHash).toBe(docHashOf(doc))
  })

  it('records without an editor as a doc-less report', async () => {
    await record({ message: 'no editor open', snapshot: null, at: 1 })
    const [read] = await listCrashReports()
    expect(read.doc).toBeNull()
    expect(read.docHash).toBeNull()
    expect(read.docId).toBeNull()
  })

  it('dedupes an identical crash inside the window and records it again after', async () => {
    const first = await record({ message: 'same trap', at: 100 })
    expect(first).not.toBeNull()
    expect(await record({ message: 'same trap', at: 100 + CRASH_DEDUPE_MS - 1 })).toBeNull()
    const later = await record({ message: 'same trap', at: 100 + CRASH_DEDUPE_MS })
    expect(later).not.toBeNull()
    expect(await listCrashReports()).toHaveLength(2)
  })

  it('keeps only the newest reports', async () => {
    for (let i = 0; i < CRASH_REPORT_LIMIT + 3; i++) {
      await record({ message: `crash ${i}`, at: 1000 + i })
    }
    const reports = await listCrashReports()
    expect(reports).toHaveLength(CRASH_REPORT_LIMIT)
    expect(reports[0].message).toBe(`crash ${CRASH_REPORT_LIMIT + 2}`)
    expect(reports.at(-1)!.message).toBe('crash 3')
  })

  it('lists newest first and deletes by id', async () => {
    await record({ message: 'older', at: 10 })
    await record({ message: 'newer', at: 20 })
    const reports = await listCrashReports()
    expect(reports.map(r => r.message)).toEqual(['newer', 'older'])

    await deleteCrashReport(reports[0].id)
    expect((await listCrashReports()).map(r => r.message)).toEqual(['older'])
  })

  it('folds a worker ErrorEvent into a message and location', async () => {
    const event = new ErrorEvent('error', { message: 'uncaught trap', filename: 'solverWorker.js', lineno: 12 })
    noteWorkerError('solver worker', event)

    const [read] = await listCrashReports().then(async list => {
      // The hook is fire-and-forget; wait for the store write to land.
      for (let i = 0; i < 50 && list.length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 5))
        list = await listCrashReports()
      }
      return list
    })
    expect(read.source).toBe('worker')
    expect(read.message).toBe('solver worker: uncaught trap (solverWorker.js:12)')
  })

  it('exposes the error shapes the handlers actually see', () => {
    expect(errorParts(new Error('boom'))).toEqual({ message: 'boom', stack: expect.stringContaining('boom') })
    expect(errorParts('thrown string')).toEqual({ message: 'thrown string', stack: null })
    expect(errorParts({ reason: new Error('rejected') })).toMatchObject({ message: 'rejected' })
    expect(errorParts({ message: 'from event' })).toEqual({ message: 'from event', stack: null })
  })
})

describe('the crash report zip', () => {
  it('carries the record, the document as YAML and the repro', async () => {
    const doc = makeDoc(makeSketch('sk1'))
    const report = (await record({
      message: 'zip me',
      snapshot: {
        ...snapshot(doc),
        repro: {
          kind: 'oversolved-repro',
          version: 1,
          docHash: docHashOf(doc),
          doc,
          seed: 7,
          warnings: [],
          journal: [],
        },
      },
      at: 5,
    }))!

    const zip = await JSZip.loadAsync(await buildCrashReportZip(report))
    const recordText = await zip.file('crash-report.json')!.async('string')
    expect(JSON.parse(recordText)).toMatchObject({ message: 'zip me', docHash: docHashOf(doc) })
    expect(await zip.file('document.yaml')!.async('string')).toContain('sk1')
    const reproText = await zip.file('repro.json')!.async('string')
    expect(JSON.parse(reproText)).toMatchObject({ kind: 'oversolved-repro', seed: 7 })
  })

  it('omits the document and repro entries when the report carries none', async () => {
    const report = (await record({ message: 'bare', snapshot: null, at: 6 }))!
    const zip = await JSZip.loadAsync(await buildCrashReportZip(report))
    expect(zip.file('crash-report.json')).not.toBeNull()
    expect(zip.file('document.yaml')).toBeNull()
    expect(zip.file('repro.json')).toBeNull()
  })

  it('names the download by time and source', () => {
    const name = crashReportFilename(
      { source: 'worker' } as Parameters<typeof crashReportFilename>[0],
      new Date(2026, 9, 15, 9, 5),
    )
    expect(name).toBe('oversolved-crash-20261015-0905-worker.zip')
  })
})
