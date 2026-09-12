import { describe, it, expect } from 'vitest'
import { createBackend } from '@/adapters/backend'
import { DownloadBugReportSink } from '@/adapters/telemetry'
import { LocalPreferences } from '@/adapters/preferences'
import type { WorkspaceDocuments } from '@/adapters/openWorkspace'

// Throwaway stand-in for the document port: createBackend just passes it
// through, so its methods never run in these tests.
const fakeStore = {} as WorkspaceDocuments

describe('backend capability bundle', () => {
  // The point of the factory is that storage is injected, not looked up: this is
  // the assertion that keeps `documents` swappable for a different workspace
  // document face without any view noticing.
  it('passes the injected document port straight through', () => {
    const bundle = createBackend(fakeStore)
    expect(bundle.documents).toBe(fakeStore)
  })

  it('wires the browser-local telemetry and preferences implementations', () => {
    const bundle = createBackend(fakeStore)
    expect(bundle.telemetry).toBeInstanceOf(DownloadBugReportSink)
    expect(bundle.preferences).toBeInstanceOf(LocalPreferences)
  })

  // Every slot is filled, always. A capability that could be missing would put an
  // `if (bundle.x)` fork back into every view that reads it, which is exactly what
  // the bundle exists to prevent.
  it('leaves no slot null', () => {
    const bundle = createBackend(fakeStore)
    for (const [name, value] of Object.entries(bundle)) {
      expect(value, `capability ${name}`).not.toBeNull()
    }
  })
})
