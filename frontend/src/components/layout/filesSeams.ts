import { useEffect, useState } from 'react'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMeta, ProvenanceRecord } from '@/workspace/types'
import { invertReferences } from './filesModel'

// The two C5/C6 seams, kept out of FilesPanel so the component file only exports
// a component (fast refresh) and the seam has one obvious home. C5 replaces
// useWhereUsed's body with its where-used index; C6 fills useOrigin's record
// with rev, hash and status. Neither call site moves.

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

export function useOrigin(session: WorkspaceSession | null, entryId: string): ProvenanceRecord | undefined {
  const [origin, setOrigin] = useState<ProvenanceRecord | undefined>(undefined)
  useEffect(() => {
    if (!session) return
    let cancelled = false
    session.originOf(entryId)
      .then(record => { if (!cancelled) setOrigin(record) })
      .catch(() => { if (!cancelled) setOrigin(undefined) })
    return () => { cancelled = true }
  }, [session, entryId])
  return session ? origin : undefined
}
