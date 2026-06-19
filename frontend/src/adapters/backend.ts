// The backend, bundled as ONE injected capability set (static-build-notes.md,
// cross-cutting section "backend as an injected capability bundle").
//
// This is the composition root for the server-facing capabilities. The whole app
// is parameterised over a single `BackendBundle`; views read a capability off the
// bundle and never ask "is there a backend". A feature exists because its
// capability was provided and is absent because it was not -- absence is
// structural (a null slot), not an `if (hasBackend)` fork sprayed through views.
//
// Two configurations of one app, not two code paths through it:
//   - HTTP build   -> every capability wired to the Flask PDM backend.
//   - static build -> documents = IndexedDB, telemetry = download; docs/sharing
//     absent (no server to serve docs from, no other users to share with).
import type { DocumentStore } from '@/stores/documentStore'
import { getLocalStore, getCloudStore } from '@/stores/documentStore'
import { backend, type Backend as BackendFlag } from '@/config/capabilities'
import { createBugReportSink, type BugReportSink } from './telemetry'
import { createDocsSource, type DocsSource } from './docs'
import { createSharingAdapter, type SharingAdapter } from './sharing'
import { createPreferencesAdapter, type PreferencesAdapter } from './preferences'

export interface BackendBundle {
  documents: DocumentStore            // the LOCAL home library: IndexedDB on BOTH builds (doc-domain-move)
  cloudDocuments: DocumentStore | null  // the additive CLOUD domain; null without a server
  telemetry: BugReportSink            // always present (POST with a server, file download without)
  preferences: PreferencesAdapter     // always present (per-user on the server, localStorage without)
  docs: DocsSource | null             // null without a server to serve the markdown docs
  sharing: SharingAdapter | null      // null without other users to share with
}

// Pure factory (testable without touching the env). The stores are passed in
// rather than resolved here so a test can hand them fakes and the boot path can
// keep the lazy singletons.
//
// Home is local on BOTH builds: `documents` is the IndexedDB library and the
// server store is the separate `cloudDocuments` domain, never "home". This is the
// store-home inversion from static-build-notes ("IndexedDB is home in BOTH builds").
export function createBackend(
  flag: BackendFlag,
  documents: DocumentStore,
  cloudDocuments: DocumentStore | null,
): BackendBundle {
  return {
    documents,
    cloudDocuments,
    telemetry: createBugReportSink(flag),
    preferences: createPreferencesAdapter(flag),
    docs: createDocsSource(flag),
    sharing: createSharingAdapter(flag),
  }
}

// Boot-time singleton, assembled once from the build flag. Views import this.
export const backendBundle: BackendBundle = createBackend(backend, getLocalStore(), getCloudStore())
