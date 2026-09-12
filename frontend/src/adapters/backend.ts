// The composition root: every capability the app is parameterised over, wired
// once, here.
//
// There is no server. The app is a browser tab -- IndexedDB for storage, WASM
// for compute -- so "backend" here means the set of ports behind which the
// platform sits, not a machine somewhere. Each port has exactly one
// implementation today, and the bundle is what keeps that from being the same
// thing as having no port at all: a view reads a capability off the bundle and
// never names a concrete class, so swapping storage (OPFS, a file-system handle,
// a sync engine) is an edit to `createBackend` and nothing else. That
// pluggability is a stated project goal, and this file is where it is paid for.
//
// One bundle rather than separate module singletons because the capabilities are
// wired together, not independently: a test that hands `documents` a fake wants
// the rest of the bundle to be the matching fakes. It also gives every consumer
// one import to reach for instead of a per-capability import graph to keep
// straight.
import type { WorkspaceDocuments } from './openWorkspace'
import { activeDocumentStore } from './openWorkspace'
import { DownloadBugReportSink, type BugReportSink } from './telemetry'
import { LocalPreferences, type PreferencesAdapter } from './preferences'

export interface BackendBundle {
  documents: WorkspaceDocuments  // the open workspace's document face
  telemetry: BugReportSink  // where a bug report goes
  preferences: PreferencesAdapter  // where the UI's remembered choices live
}

// Pure factory (testable without touching the env). The storage port is passed
// in rather than resolved here so a test can hand it a fake while the boot path
// keeps the lazy singleton; telemetry and preferences own no state worth
// injecting, so they are constructed inline.
export function createBackend(documents: WorkspaceDocuments): BackendBundle {
  return {
    documents,
    telemetry: new DownloadBugReportSink(),
    preferences: new LocalPreferences(),
  }
}

// Boot-time singleton. Views import this. The document face is bound to
// whichever workspace the WorkspacePage session installed; a call with no open
// workspace refuses by name rather than listing the whole library.
export const backendBundle: BackendBundle = createBackend(activeDocumentStore)
