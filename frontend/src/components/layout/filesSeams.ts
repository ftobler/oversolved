import { useEffect, useState } from 'react'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMeta } from '@/workspace/types'
import { invertReferences } from './filesModel'

// The where-used seam, kept out of its consumer so the component file only
// exports a component (fast refresh) and the seam has one obvious home. C5
// replaced the old per-entry scan with the manifest's one edge-map read. The
// origin seam that used to live here was only reached by the origins panel; R5
// put the update path back on an entry row, which reads the workspace view's
// one provenance load rather than a seam of its own.

const EMPTY_INVERSE = new Map<string, string[]>()

export interface WhereUsed {
  inverse: Map<string, string[]>
  // True only once a scan has resolved for the current session and entry list.
  // Callers must not treat an unscanned file as an orphan: a file with a
  // referrer would look unreferenced while its edges are still being read.
  ready: boolean
}

interface WhereUsedScan {
  session: WorkspaceSession
  entries: EntryMeta[]
  inverse: Map<string, string[]>
}

const NOT_READY: WhereUsed = { inverse: EMPTY_INVERSE, ready: false }

export function useWhereUsed(session: WorkspaceSession | null, entries: EntryMeta[]): WhereUsed {
  const [scan, setScan] = useState<WhereUsedScan | null>(null)
  useEffect(() => {
    if (!session) return
    let cancelled = false
    const run = async () => {
      // One edge-map read, inverted. The old body issued one referencesOf read
      // per entry; C5's index reads the manifest's reference map once.
      try {
        const edges = await session.referenceEdges()
        if (!cancelled) setScan({ session, entries, inverse: invertReferences(edges) })
      } catch {
        // An unreadable manifest is an empty index, not an unhandled rejection.
        if (!cancelled) setScan({ session, entries, inverse: EMPTY_INVERSE })
      }
    }
    void run()
    return () => { cancelled = true }
  }, [session, entries])
  // Identity comparison, not a state flag set in the effect: during the render
  // where the entries change, the previous scan is still in state, and only
  // matching it keeps a stale inverse from being read as the current one.
  const ready = session !== null && scan !== null && scan.session === session && scan.entries === entries
  return ready && scan ? { inverse: scan.inverse, ready } : NOT_READY
}
