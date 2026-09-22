import { describe, it, expect, beforeEach } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { IdbWorkspaceStore } from '../store'
import { createWorkspaceSession } from '../session'
import { liftInlineStepPayloads, migrateInlineStepPayloads } from '../inlineStepMigration'
import { readWorkspaceMeta } from '../idbCarrier'
import { getFileRegistry } from '@/stores/fileRegistry'
import { resetWorkspaceIdb } from './idbHarness'

// The pre-registry `file_data` documents A2 assumed were disposable. They are
// not: a real library carries them, they export as tens of megabytes of base64
// and they refuse to solve at all. These pin the lift that turns one into the
// file_id + file-entry shape a fresh STEP import already produces.

const STEP = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'

// Quoted, because the payload sits in the document as a YAML scalar and the
// point of the case is a decode failure, not a parse failure.
const NOT_BASE64 = '"@@@@"'

function base64Of(text: string): string {
  return btoa(text)
}

function docWithInlineStep(payload: string, extra: Record<string, unknown> = {}): string {
  return [
    'features:',
    '  - id: Origin',
    '    kind: origin',
    '  - id: imp1',
    '    kind: import_step',
    '    label: bracket.step',
    ...Object.entries(extra).map(([key, value]) => `    ${key}: ${String(value)}`),
    `    file_data: ${payload}`,
    '',
  ].join('\n')
}

describe('lifting an inline STEP payload out of a document', () => {
  it('replaces file_data with a file_id and hands back the decoded bytes', () => {
    let n = 0
    const result = liftInlineStepPayloads(docWithInlineStep(base64Of(STEP)), () => `file-${++n}`)

    expect(result).not.toBeNull()
    expect(result!.files).toHaveLength(1)
    expect(result!.files[0]).toMatchObject({ fileId: 'file-1', name: 'bracket.step' })
    expect(new TextDecoder().decode(result!.files[0].bytes)).toBe(STEP)

    const doc = parseYaml(result!.text) as { features: Record<string, unknown>[] }
    const imported = doc.features[1]
    expect(imported.file_id).toBe('file-1')
    expect('file_data' in imported).toBe(false)
    // Everything else about the feature survives the rewrite verbatim.
    expect(imported).toMatchObject({ id: 'imp1', kind: 'import_step', label: 'bracket.step' })
  })

  it('returns null for a document with nothing to lift, so no write happens', () => {
    expect(liftInlineStepPayloads('kind: part\nfeatures:\n  - id: a\n    kind: extrude\n')).toBeNull()
    expect(liftInlineStepPayloads('features:\n  - id: i\n    kind: import_step\n    file_id: f1\n')).toBeNull()
    expect(liftInlineStepPayloads('features: []\n')).toBeNull()
    expect(liftInlineStepPayloads('not: a mapping of features\n')).toBeNull()
    expect(liftInlineStepPayloads('[unparseable\n')).toBeNull()
  })

  it('stores the bytes under an existing file_id rather than minting a second one', () => {
    const text = docWithInlineStep(base64Of(STEP), { file_id: 'already-there' })
    const result = liftInlineStepPayloads(text, () => 'minted')

    expect(result!.files[0].fileId).toBe('already-there')
    const doc = parseYaml(result!.text) as { features: Record<string, unknown>[] }
    expect(doc.features[1].file_id).toBe('already-there')
  })

  it('decodes a payload YAML wrapped across lines', () => {
    const payload = base64Of(STEP)
    const folded = [
      'features:',
      '  - id: imp1',
      '    kind: import_step',
      '    file_data: >-',
      `      ${payload.slice(0, 8)}`,
      `      ${payload.slice(8)}`,
      '',
    ].join('\n')
    const result = liftInlineStepPayloads(folded, () => 'f1')
    expect(new TextDecoder().decode(result!.files[0].bytes)).toBe(STEP)
  })

  it('lifts every import_step in a document, naming one without a label after its feature', () => {
    let n = 0
    const text = [
      'features:',
      '  - id: imp1',
      '    kind: import_step',
      '    label: a.step',
      `    file_data: ${base64Of('one')}`,
      '  - id: imp2',
      '    kind: import_step',
      `    file_data: ${base64Of('two')}`,
      '',
    ].join('\n')
    const result = liftInlineStepPayloads(text, () => `f${++n}`)

    expect(result!.files.map(f => f.name)).toEqual(['a.step', 'imp2.step'])
    expect(result!.files.map(f => new TextDecoder().decode(f.bytes))).toEqual(['one', 'two'])
  })

  it('leaves an undecodable payload in place and reports it, rather than writing a corrupt file', () => {
    const result = liftInlineStepPayloads(docWithInlineStep(NOT_BASE64), () => 'f1')

    expect(result).not.toBeNull()
    expect(result!.files).toHaveLength(0)
    expect(result!.undecodable).toEqual(['imp1'])
    // The feature is untouched, so the kernel keeps refusing it by name instead
    // of solving against bytes that are not a STEP file.
    const doc = parseYaml(result!.text) as { features: Record<string, unknown>[] }
    expect(doc.features[1].file_data).toBe('@@@@')
  })
})

describe('migrating a workspace that holds inline STEP payloads', () => {
  beforeEach(async () => {
    resetWorkspaceIdb()
    await getFileRegistry().clear()
  })

  async function workspaceWithInlineDoc(): Promise<{ store: IdbWorkspaceStore; workspace: string }> {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    await store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Bracket', docKind: 'part',
      text: docWithInlineStep(base64Of(STEP)),
    })
    return { store, workspace }
  }

  it('moves the bytes into a file entry the document then refers to', async () => {
    const { store, workspace } = await workspaceWithInlineDoc()

    const report = await migrateInlineStepPayloads(workspace, store)
    expect(report).toMatchObject({ documents: 1, files: 1, undecodable: [] })

    const doc = await store.readEntry(workspace, workspace)
    expect(doc.text).not.toContain('file_data')
    const parsed = parseYaml(doc.text!) as { features: Record<string, unknown>[] }
    const fileId = parsed.features[1].file_id as string
    expect(typeof fileId).toBe('string')

    const file = await store.readEntry(workspace, fileId)
    expect(file).toMatchObject({ kind: 'file', name: 'bracket.step', fileKind: 'step' })
    expect(new TextDecoder().decode(file.bytes!)).toBe(STEP)

    // The solve path resolves a file id through the session, so the healed
    // document must be solvable, not merely smaller.
    const session = createWorkspaceSession(workspace, store)
    expect(new TextDecoder().decode((await session.resolveFile(fileId))!)).toBe(STEP)
    // Membership is what keeps the file from being pruned as an orphan.
    expect(await session.referencesOf(workspace)).toContain(fileId)
  })

  it('marks the workspace so a reopen does no work', async () => {
    const { store, workspace } = await workspaceWithInlineDoc()

    await migrateInlineStepPayloads(workspace, store)
    expect((await readWorkspaceMeta(workspace))?.migrations).toContain('inline-step-payloads')

    const second = await migrateInlineStepPayloads(workspace, store)
    expect(second).toMatchObject({ skipped: true, documents: 0, files: 0 })
  })

  it('marks a workspace with nothing to migrate without rewriting any document', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Clean', { docKind: 'part' })
    const revOf = async () => (await store.listEntries(workspace)).find(e => e.id === workspace)?.rev
    const before = await revOf()

    const report = await migrateInlineStepPayloads(workspace, store)
    expect(report).toMatchObject({ documents: 0, files: 0 })

    // An untouched document keeps its rev, so the pass cannot raise a dirty dot
    // on a workspace it changed nothing in.
    expect(await revOf()).toBe(before)
    expect((await readWorkspaceMeta(workspace))?.migrations).toContain('inline-step-payloads')
  })

  it('skips a workspace that has no meta row without creating one', async () => {
    const store = new IdbWorkspaceStore()
    const report = await migrateInlineStepPayloads('ghost-workspace', store)

    expect(report).toMatchObject({ skipped: true, documents: 0, files: 0 })
    // Marking a workspace into existence would write a row the store never
    // created, so an absent meta is a no-op, not a tombstone.
    expect(await readWorkspaceMeta('ghost-workspace')).toBeUndefined()
  })

  it('converges on a half-migrated document whose file entry already exists', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    await store.addEntry(workspace, {
      id: 'existing-file', kind: 'file', name: 'bracket.step',
      mime: 'application/step', fileKind: 'step', bytes: new Uint8Array([1, 2, 3]),
    })
    await store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Bracket', docKind: 'part',
      text: docWithInlineStep(base64Of(STEP), { file_id: 'existing-file' }),
    })

    const report = await migrateInlineStepPayloads(workspace, store)
    expect(report).toMatchObject({ documents: 1, files: 1 })

    // The existing entry is left alone instead of being re-added or overwritten.
    expect((await store.readEntry(workspace, 'existing-file')).bytes).toEqual(new Uint8Array([1, 2, 3]))
    const doc = await store.readEntry(workspace, workspace)
    expect(doc.text).not.toContain('file_data')
    expect(doc.text).toContain('existing-file')
  })

  it('heals the other documents when one payload cannot be decoded', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Ws', { docKind: 'part' })
    await store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Good', docKind: 'part',
      text: docWithInlineStep(base64Of(STEP)),
    })
    await store.addEntry(workspace, {
      id: 'doc-bad', kind: 'document', name: 'Bad', docKind: 'part',
      text: docWithInlineStep(NOT_BASE64),
    })

    const report = await migrateInlineStepPayloads(workspace, store)
    expect(report).toMatchObject({ documents: 1, files: 1 })
    expect(report.undecodable).toEqual(['Bad/imp1'])
    expect((await store.readEntry(workspace, 'doc-bad')).text).toContain('file_data')
  })
})
