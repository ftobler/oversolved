import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { getPreviewStore, resetPreviewDbConnection } from '..'
import { capturePreview, copyPreview, copyWorkspacePreviews } from '../capture'

// The first-solve capture is a gap-filler, not a second writer racing the save:
// opening a document must leave a preview the user already has alone. These
// pin that decision and the best-effort copy used by clone/duplicate.
describe('preview captures outside the save path', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetPreviewDbConnection()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fills an empty key', async () => {
    const capture = vi.fn(async () => 'data:image/png;base64,TkVX')

    await capturePreview(capture, 'ws-1', 'e1')

    expect(capture).toHaveBeenCalledTimes(1)
    expect(await getPreviewStore().get('ws-1', 'e1')).toBe('TkVX')
  })

  it('leaves an existing preview alone instead of replacing it from the first solve', async () => {
    await getPreviewStore().put('ws-1', 'e1', 'T0xE')
    const capture = vi.fn(async () => 'data:image/png;base64,TkVX')

    await capturePreview(capture, 'ws-1', 'e1')

    expect(capture).not.toHaveBeenCalled()
    expect(await getPreviewStore().get('ws-1', 'e1')).toBe('T0xE')
  })

  it('does not spend the capture when the store cannot say whether one exists', async () => {
    vi.spyOn(getPreviewStore(), 'get').mockRejectedValueOnce(new Error('database blocked'))
    const capture = vi.fn(async () => 'data:image/png;base64,TkVX')

    await capturePreview(capture, 'ws-1', 'e1')

    expect(capture).not.toHaveBeenCalled()
  })

  it('keeps a save that landed while the capture was rendering', async () => {
    // The first read saw an empty key, but the save wrote while the capture was
    // in flight. The atomic put-if-absent is what keeps the save's image.
    const capture = vi.fn(async () => {
      await getPreviewStore().put('ws-1', 'e1', 'U0FWRUQ=')
      return 'data:image/png;base64,TkVX'
    })

    await capturePreview(capture, 'ws-1', 'e1')

    expect(await getPreviewStore().get('ws-1', 'e1')).toBe('U0FWRUQ=')
  })

  it('copies one key and treats a missing source as a miss', async () => {
    await getPreviewStore().put('ws-1', 'source', 'SU1H')

    await copyPreview('ws-1', 'source', 'ws-2', 'copy')
    await copyPreview('ws-1', 'missing', 'ws-2', 'other')

    expect(await getPreviewStore().get('ws-2', 'copy')).toBe('SU1H')
    expect(await getPreviewStore().get('ws-2', 'other')).toBeUndefined()
  })

  it('copies a whole id map and skips the rows with no source preview', async () => {
    await getPreviewStore().put('ws-1', 'a', 'QQ==')
    await getPreviewStore().put('ws-1', 'b', 'Qg==')

    await copyWorkspacePreviews('ws-1', 'ws-2', new Map([
      ['a', 'a-new'],
      ['b', 'b-new'],
      ['c', 'c-new'],
    ]))

    expect(await getPreviewStore().get('ws-2', 'a-new')).toBe('QQ==')
    expect(await getPreviewStore().get('ws-2', 'b-new')).toBe('Qg==')
    expect(await getPreviewStore().get('ws-2', 'c-new')).toBeUndefined()
  })
})
