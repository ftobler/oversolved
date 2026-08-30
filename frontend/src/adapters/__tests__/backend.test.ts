import { describe, it, expect } from 'vitest'
import { createBackend } from '@/adapters/backend'
import { DownloadBugReportSink } from '@/adapters/telemetry'
import { LocalPreferences } from '@/adapters/preferences'
import type { DocumentStore, TrashAdapter } from '@/stores/documentStore'

// Throwaway stand-ins for the storage ports: createBackend just passes them
// through, so the methods never run in these tests.
const fakeStore = {} as DocumentStore
const fakeTrash = {} as TrashAdapter

describe('backend capability bundle', () => {
  // The point of the factory is that storage is injected, not looked up: this is
  // the assertion that keeps `documents` swappable for a different DocumentStore
  // without any view noticing.
  it('passes the injected storage ports straight through', () => {
    const bundle = createBackend(fakeStore, fakeTrash)
    expect(bundle.documents).toBe(fakeStore)
    expect(bundle.localTrash).toBe(fakeTrash)
  })

  it('wires the browser-local telemetry and preferences implementations', () => {
    const bundle = createBackend(fakeStore, fakeTrash)
    expect(bundle.telemetry).toBeInstanceOf(DownloadBugReportSink)
    expect(bundle.preferences).toBeInstanceOf(LocalPreferences)
  })

  // Every slot is filled, always. A capability that could be missing would put an
  // `if (bundle.x)` fork back into every view that reads it, which is exactly what
  // the bundle exists to prevent.
  it('leaves no slot null', () => {
    const bundle = createBackend(fakeStore, fakeTrash)
    for (const [name, value] of Object.entries(bundle)) {
      expect(value, `capability ${name}`).not.toBeNull()
    }
  })
})
