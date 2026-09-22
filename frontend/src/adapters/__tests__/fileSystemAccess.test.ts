import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  canPickDirectory, canPickWorkspaceZip, pickLibraryDirectory, pickWorkspaceZip, hasReadWritePermission,
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

describe('hasReadWritePermission', () => {
  it('accepts a handle whose grant is still in force without prompting', async () => {
    const requestPermission = vi.fn()
    const handle = { queryPermission: async () => 'granted' as PermissionState, requestPermission }
    expect(await hasReadWritePermission(handle, { request: true })).toBe(true)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  // The boot-time probe runs outside a user gesture, where requestPermission
  // throws. It must answer false and leave the asking to the next click.
  it('does not prompt when asked not to', async () => {
    const requestPermission = vi.fn(async () => 'granted' as PermissionState)
    const handle = { queryPermission: async () => 'prompt' as PermissionState, requestPermission }
    expect(await hasReadWritePermission(handle, { request: false })).toBe(false)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('prompts and reports the answer when asked to', async () => {
    const handle = {
      queryPermission: async () => 'prompt' as PermissionState,
      requestPermission: async () => 'granted' as PermissionState,
    }
    expect(await hasReadWritePermission(handle, { request: true })).toBe(true)
  })

  it('reports a refused prompt as no permission', async () => {
    const handle = {
      queryPermission: async () => 'prompt' as PermissionState,
      requestPermission: async () => 'denied' as PermissionState,
    }
    expect(await hasReadWritePermission(handle, { request: true })).toBe(false)
  })

  // A denied grant is final for this session; re-prompting would be a popup
  // loop the user cannot escape.
  it('never re-prompts a denied handle', async () => {
    const requestPermission = vi.fn(async () => 'granted' as PermissionState)
    const handle = { queryPermission: async () => 'denied' as PermissionState, requestPermission }
    expect(await hasReadWritePermission(handle, { request: true })).toBe(false)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  // Handles from engines without the permission methods (OPFS, the spec
  // baseline) are already writable; refusing them would lock the store out of
  // a directory it can in fact write.
  it('treats a handle with no permission API as permitted', async () => {
    expect(await hasReadWritePermission({}, { request: true })).toBe(true)
  })

  it('reports a vanished directory as no permission', async () => {
    const handle = { queryPermission: async () => { throw new Error('gone') } }
    expect(await hasReadWritePermission(handle, { request: true })).toBe(false)
  })
})
