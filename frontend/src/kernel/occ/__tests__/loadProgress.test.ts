// The OCC load progress store: the phases a load moves through, the byte
// counters the overlay renders, and the subscription the overlay uses. It is a
// plain module so the whole state machine is testable without a browser or a
// worker; the Worker relays snapshots through [[applyOccLoadProgress]].
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  applyOccLoadProgress,
  beginOccLoad,
  getOccLoadProgress,
  occLoadPercent,
  reportOccCompiling,
  reportOccDownload,
  reportOccFailed,
  reportOccReady,
  resetOccLoadProgress,
  subscribeOccLoadProgress,
} from '../loadProgress'

beforeEach(resetOccLoadProgress)

describe('occ load progress', () => {
  it('starts idle', () => {
    expect(getOccLoadProgress()).toEqual({ phase: 'idle', loadedBytes: 0, totalBytes: 0 })
  })

  it('walks downloading -> compiling -> ready, keeping the byte counters', () => {
    beginOccLoad()
    expect(getOccLoadProgress().phase).toBe('downloading')
    reportOccDownload(50, 100)
    expect(getOccLoadProgress()).toEqual({ phase: 'downloading', loadedBytes: 50, totalBytes: 100 })
    reportOccCompiling()
    expect(getOccLoadProgress()).toEqual({ phase: 'compiling', loadedBytes: 50, totalBytes: 100 })
    reportOccReady()
    expect(getOccLoadProgress()).toEqual({ phase: 'ready', loadedBytes: 50, totalBytes: 100 })
  })

  it('keeps the last byte counts on failure', () => {
    beginOccLoad()
    reportOccDownload(10, 100)
    reportOccFailed()
    expect(getOccLoadProgress()).toEqual({ phase: 'failed', loadedBytes: 10, totalBytes: 100 })
  })

  it('a restart resets stale counters from an earlier attempt', () => {
    beginOccLoad()
    reportOccDownload(90, 100)
    beginOccLoad()
    expect(getOccLoadProgress()).toEqual({ phase: 'downloading', loadedBytes: 0, totalBytes: 0 })
  })

  it('notifies every subscriber until it unsubscribes', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = subscribeOccLoadProgress(first)
    subscribeOccLoadProgress(second)

    beginOccLoad()
    reportOccDownload(1, 2)
    expect(first).toHaveBeenCalledTimes(2)
    expect(first.mock.calls[1][0]).toEqual({ phase: 'downloading', loadedBytes: 1, totalBytes: 2 })
    expect(second).toHaveBeenCalledTimes(2)

    unsubscribe()
    reportOccDownload(2, 2)
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(3)
  })

  it('applies a snapshot relayed from the worker', () => {
    applyOccLoadProgress({ phase: 'downloading', loadedBytes: 3, totalBytes: 9 })
    expect(getOccLoadProgress()).toEqual({ phase: 'downloading', loadedBytes: 3, totalBytes: 9 })
  })

  describe('percent', () => {
    it('is null when the server sent no Content-Length', () => {
      expect(occLoadPercent({ phase: 'downloading', loadedBytes: 5, totalBytes: 0 })).toBeNull()
    })

    it('floors the ratio', () => {
      expect(occLoadPercent({ phase: 'downloading', loadedBytes: 1, totalBytes: 3 })).toBe(33)
    })

    it('caps at 100 when decoded bytes outrun a compressed Content-Length', () => {
      expect(occLoadPercent({ phase: 'downloading', loadedBytes: 200, totalBytes: 100 })).toBe(100)
    })
  })
})
