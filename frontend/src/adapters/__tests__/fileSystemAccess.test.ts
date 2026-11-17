// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  canPickDirectory, canPickWorkspaceZip, pickLibraryDirectory, pickWorkspaceZip,
} from '../fileSystemAccess'

// jsdom is the Firefox/Safari shape by default: no pickers on window at all.
// Each case installs only what it is about, and afterEach puts that back, so
// "the capability is absent" is the tested baseline rather than an assumption.
function installPickers(pickers: Record<string, unknown>): void {
  for (const [name, fn] of Object.entries(pickers)) {
    Object.defineProperty(window, name, { value: fn, configurable: true, writable: true })
  }
}

function clearPickers(): void {
  installPickers({ showDirectoryPicker: undefined, showOpenFilePicker: undefined })
}

const abort = () => { throw new DOMException('The user aborted a request.', 'AbortError') }

describe('file system access capability', () => {
  afterEach(clearPickers)

  it('reports no directory picking on a browser without the API', () => {
    clearPickers()
    expect(canPickDirectory()).toBe(false)
  })

  // Absence must be structural: a caller on Firefox gets null without the
  // module ever touching an undefined picker.
  it('returns null from the directory picker when the API is absent', async () => {
    clearPickers()
    expect(await pickLibraryDirectory()).toBeNull()
  })

  it('asks for readwrite on the directory picker', async () => {
    const showDirectoryPicker = vi.fn(async () => ({ name: 'cad' }))
    installPickers({ showDirectoryPicker })
    const handle = await pickLibraryDirectory()
    expect(handle).toEqual({ name: 'cad' })
    expect(showDirectoryPicker).toHaveBeenCalledWith(expect.objectContaining({ mode: 'readwrite' }))
  })

  // Cancelling a picker is a non-event, not a failure: it must not reach an
  // error banner.
  it('folds a user cancellation into null', async () => {
    installPickers({ showDirectoryPicker: abort })
    expect(await pickLibraryDirectory()).toBeNull()
  })

  it('propagates a real picker failure', async () => {
    installPickers({ showDirectoryPicker: () => { throw new Error('boom') } })
    await expect(pickLibraryDirectory()).rejects.toThrow('boom')
  })
})

describe('workspace zip picking', () => {
  afterEach(clearPickers)

  it('reports no zip picking without the file picker', async () => {
    clearPickers()
    expect(canPickWorkspaceZip()).toBe(false)
    expect(await pickWorkspaceZip()).toBeNull()
  })

  it('returns the picked file handle', async () => {
    const handle = { name: 'ws.zip' }
    installPickers({ showOpenFilePicker: vi.fn(async () => [handle]) })
    expect(canPickWorkspaceZip()).toBe(true)
    expect(await pickWorkspaceZip()).toBe(handle)
  })

  it('folds a user cancellation into null', async () => {
    installPickers({ showOpenFilePicker: abort })
    expect(await pickWorkspaceZip()).toBeNull()
  })

  // Symmetric with the directory picker: only a cancellation is a non-event. A
  // real failure has to reach the caller rather than read as "no file picked".
  it('propagates a real zip picker failure', async () => {
    installPickers({ showOpenFilePicker: () => { throw new Error('boom') } })
    await expect(pickWorkspaceZip()).rejects.toThrow('boom')
  })
})

