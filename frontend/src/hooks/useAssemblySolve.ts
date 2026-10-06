// Main-thread driver for the assembly mate solve. Registers the relay handlers
// the anchor solver worker needs (it cannot reach the document store or OCC
// itself), turns an AssemblyDoc into a solveAssembly request, and pushes the
// solved transforms + bodies into assemblyStore.
//
// One solve per request, coalesced: a re-solve asked for while another is in
// flight queues exactly one follow-up rather than stacking. Mate edits and
// pointer-up drags both land here (Stage 6d), so a burst never fans out into a
// pile of redundant OCC-free solves.

import { useCallback, useEffect, useRef, useState } from 'react'
import { parse as parseYaml } from 'yaml'
import type { AssemblyDoc, AssemblyFeature, PartDoc } from '@/types/cad'
import { migrateLegacyBodyPicks } from '@/utils/yamlMutations'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { buildEntityMateRefs, toBodyResults, toEdgeCurves } from '@/utils/assemblyBodies'
import { buildAnchorTable } from '@/utils/anchorGizmos'
import { buildPickBodies } from '@/utils/assemblyPick'
import { setRelayHandlers, clearRelayHandlers, solveAssemblyViaWorker, cancelAssemblySolver } from '@/kernel/worker/anchorSolverClient'
import { buildBundleViaWorker } from '@/kernel/worker/solverClient'
import { fileIdsMissingFromWorker } from '@/kernel/worker/workerFiles'
import { getFileRegistry } from '@/stores/fileRegistry'
import { fileIdsInSpec } from '@/stores/fileRegistry/resolve'
import { partBundleKey } from '@/workspace/contentHash'
import { workspaceStoreRevision } from '@/workspace/storeEvents'
import type { PartInputSpec } from '@/kernel/worker/solverProtocol'
import type { MateSpec, AssemblySolveStatus } from '@/kernel/solveAssembly'
import { dragTargetMate, dragTargetPoseMate } from '@/kernel/assemblyDrag'
import { extractErrorMessage } from '@/kernel/errors'
import { findInstance } from '@/utils/assemblyMutations'
import { livePartPose } from '@/utils/partManipulation'
import { useSolverStore } from '@/stores/solverStore'

// A failure the user walked into is not an error to banner: a cancel kills the
// in-flight solve deliberately, and a watchdog timeout is the same drop of a
// presumed-stuck worker as the part path (`useSolver`'s benign set). A worker
// trap and its cooldown backoff are infrastructure noise too -- the console
// error already surfaced the crash, and every request inside the backoff window
// rejects with the backoff string purely by design -- so both the anchor and the
// OCC worker crash strings are benign, matching `BENIGN_SOLVE_FAILURES`.
// Everything else is a real failure the user should see.
const BENIGN_ASSEMBLY_FAILURES = new Set([
  'assembly solve cancelled',
  'anchor solver timed out',
  'anchor solver worker crashed',
  'anchor solver worker crashed (backoff)',
  'solver worker crashed',
  'solver worker crashed (backoff)',
])

// A live drag tick carries the per-mate and per-part marks only. Withholding the
// overall verdict (and its error) keeps a per-frame overconstrained from
// flickering the banner; the pointer-up full solve owns the real verdict.
function liveStatus(status: AssemblySolveStatus | undefined): AssemblySolveStatus | null {
  if (!status) return null
  return { ...status, verdict: 'none', error: undefined }
}

export function partSpecs(doc: AssemblyDoc): PartInputSpec[] {
  return (doc.features ?? [])
    .filter(f => f.kind === 'part_instance' && f.instance)
    .map(f => ({
      handle: f.instance!.handle,
      doc_id: f.instance!.doc_id,
      transform: f.instance!.transform,
      fixed: f.instance!.fixed,
    }))
}

export function mateSpecs(doc: AssemblyDoc): MateSpec[] {
  return (doc.features ?? [])
    .filter((f): f is AssemblyFeature => f.kind === 'mate' && !!f.mate)
    .map(f => ({
      id: f.id,
      kind: f.mate!.kind,
      // Rebuild each ref from its authored fields only. A hand-edited YAML
      // could carry a stray `inlineAnchor`; dropping it keeps the solve's
      // inline-anchor trust exemption (drag objective only) unreachable from a
      // document. `anchor_descriptor` is the durable identity and must ride
      // along, or a cold-cache resolve loses the only fallback it has.
      ref_a: {
        part: f.mate!.ref_a.part,
        anchor: f.mate!.ref_a.anchor,
        anchor_descriptor: f.mate!.ref_a.anchor_descriptor,
      },
      ref_b: {
        part: f.mate!.ref_b.part,
        anchor: f.mate!.ref_b.anchor,
        anchor_descriptor: f.mate!.ref_b.anchor_descriptor,
      },
      flip: f.mate!.flip,
      // Passed through in its authored form, scalar or vector: normalizing it
      // needs the anchor axis, which only resolves inside the solve (see
      // `mateOffsetVector` at solveAssembly.ts's record build).
      offset: f.mate!.offset,
      // Authored values, including an expression string: the solve boundary
      // refuses an unresolved one rather than reading it as 0.
      angle: f.mate!.angle,
      radius: f.mate!.radius,
      ratio: f.mate!.ratio,
    }))
}

// The identity the burst cache is keyed to: the uuid plus the workspace store
// revision, which bumps on every working-copy write. A mid-burst edit therefore
// invalidates the cached hash map, so the next non-live solve re-fetches instead
// of committing against a pre-edit bundle. The part list itself is stable across
// a drag, so a live tick reuses the last full solve's map regardless.
function hashCacheKey(uuid: string, revision: number): string {
  return `${uuid}|${revision}`
}

/**
 * The content-hash key per referenced part, the bundle cache's invalidation
 * signal. The instance's own recorded `doc_rev` is only placement provenance now;
 * the current content comes from the open workspace session's entry hash, with
 * the content hashes of its one-level file dependencies folded in so replacing a
 * referenced STEP's bytes invalidates too. Refs are read from the session, never
 * the library, so an assembly can only key against documents that live beside it.
 *
 * A part whose hash is unknown (a store read failure) is omitted, which bypasses
 * the cache for that part rather than ever risking a stale hit.
 */
export async function currentHashes(doc: AssemblyDoc): Promise<Record<string, string>> {
  const session = useWorkspaceSessionStore.getState().session
  if (!session) return {}
  const hashes: Record<string, string> = {}
  try {
    const [entries, edges] = await Promise.all([session.listEntries(), session.referenceEdges()])
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    for (const part of partSpecs(doc)) {
      const entry = byId.get(part.doc_id)
      if (!entry?.contentHash) continue
      const fileHashes: string[] = []
      let missing = false
      for (const fileId of edges[part.doc_id] ?? []) {
        const file = byId.get(fileId)
        if (file?.contentHash) fileHashes.push(file.contentHash)
        else if (file?.kind === 'file') missing = true
      }
      // A referenced file whose hash is unknown is a cache bypass, never a
      // stale hit. A non-file edge (an assembly to part edge) is not a bundle
      // dependency and does not affect the part key.
      if (missing) continue
      hashes[part.doc_id] = partBundleKey(entry.contentHash, fileHashes)
    }
  } catch {
    // Store unreachable: no hashes means every part bypasses the cache and
    // cold-rebuilds uncached. Never fall back to a revision key.
    return {}
  }
  return hashes
}

export function useAssemblySolve(
  uuid: string,
  doc: AssemblyDoc | null,
  { onFirstSolve }: { onFirstSolve?: () => void } = {},
) {
  const docRef = useRef<AssemblyDoc | null>(doc)
  docRef.current = doc
  // The part editor's useSolver hook point, mirrored for the assembly: the
  // editor thumbnails its scene the first time there is one. Held in a ref
  // rather than folded into runSolve's deps, because runSolve's identity drives
  // the solve effect -- a caller re-rendering with a fresh closure would
  // otherwise start a second solve for every render.
  const onFirstSolveRef = useRef(onFirstSolve)
  onFirstSolveRef.current = onFirstSolve
  const firstSolveDone = useRef(false)
  const inFlight = useRef(false)
  const queued = useRef(false)
  // Staleness token, the assembly counterpart of useSolver's requestIdRef: a
  // solve captures the version when it starts and drops its result if a newer
  // request bumped it meanwhile. The assembly worker protocol carries no token,
  // so the guard lives here on the main thread against a local counter.
  const solveVersion = useRef(0)
  // Cached under the identity the hashes were computed for (see hashCacheKey),
  // so a coalesced burst reuses the map. A doc swap or a mid-burst edit that
  // bumped the workspace revision changes the key, so the next run re-fetches
  // instead of committing against a pre-edit bundle.
  const burstHashes = useRef<{ key: string; hashes: Record<string, string> } | null>(null)
  // The hash map from the last solve, with the key it was computed for. A live
  // drag tick reuses it only while the key still matches: no part is edited
  // mid-drag (applyUndoRedo clears the drag), and re-listing entries per tick is
  // the exact cost this cache avoids.
  const lastHashes = useRef<{ key: string; hashes: Record<string, string> } | null>(null)
  // The assembly id the current render is solving for. The solve drain aborts
  // when it changes, so an old IIFE cannot keep solving against an abandoned doc.
  // Kept current in the render body so the abort check never sees a lagging uuid
  // even if the drain resumes before the effect below runs its change branch.
  const uuidRef = useRef(uuid)
  uuidRef.current = uuid
  // The uuid the solve effect last processed; the change branch compares against
  // this rather than uuidRef, whose render-body write would hide the change.
  const seenUuidRef = useRef(uuid)
  // Monotonic drain id. The drain that starts it owns the in-flight slot, and
  // only the LATEST drain may release it: on a uuid round-trip (asm-1 ->
  // asm-2 -> asm-1) a stranded drain's uuid matches the current one again, so
  // uuid equality alone cannot prove ownership.
  const drainSeq = useRef(0)
  // A solve is requested by bumping a token, never by calling runSolve inline:
  // callers ask for it in the same event that mutates the doc (a drag commit
  // writes the transform, then re-solves), and the mutated doc only reaches
  // docRef on the next render. Reading it from an effect keeps the solve from
  // running against the pose the user just moved away from.
  const [solveToken, setSolveToken] = useState(0)

  useEffect(() => {
    setRelayHandlers({
      partDocContent: async (doc_id) => {
        // The workspace session is the only resolver: a doc_id that is not a
        // live document entry in this workspace refuses by name instead of
        // falling through to a library-wide load (the C2 hole P3 closes).
        const session = useWorkspaceSessionStore.getState().session
        if (!session) throw new Error('No workspace is open')
        const entry = await session.readEntry(doc_id)
        if (entry.kind !== 'document') throw new Error(`Not a part document: ${doc_id}`)
        const doc = (parseYaml(entry.text ?? '') ?? {}) as PartDoc
        // Same self-heal as the part load seam: a legacy singular transform
        // `body` must reach the OCC worker as the plural `bodies` it reads.
        migrateLegacyBodyPicks(doc)
        return doc as unknown as Record<string, unknown>
      },
      // Stamp the doc id onto the bundle spec: the raw PartDoc YAML carries no
      // id, and solveLocally's cache-reset guard keys on spec.id. Without it,
      // bundle builds of different docs share one checkpoint slot and a bundle
      // build evicts the part editor's incremental cache.
      //
      // The spec the anchor worker holds is reference-only; the bytes are
      // resolved HERE, on the main thread, so no byte payload ever crosses the
      // anchor worker. The OCC bundle worker receives them directly. The
      // session resolves a workspace entry first and C1's flat registry second,
      // so a STEP just staged by an import still reaches the worker before the
      // workspace has adopted it.
      buildBundle: async (doc_id, content_hash, spec) => {
        const session = useWorkspaceSessionStore.getState().session
        const fileIds = fileIdsMissingFromWorker(fileIdsInSpec(spec))
        let files: Record<string, Uint8Array> | undefined
        if (fileIds.length) {
          files = {}
          for (const id of fileIds) {
            const bytes = session
              ? await session.resolveFile(id)
              : await getFileRegistry().getBytes(id)
            if (bytes) files[id] = bytes
          }
        }
        return buildBundleViaWorker({ ...spec, id: doc_id }, doc_id, content_hash, files)
      },
    })
    // Surface the cancel through the single-slot solver overlay (the assembly
    // editor mounts LoadingOverlay, which reads this slot). The part hook
    // (`useSolver`) and this hook never co-mount - they live on different
    // pages - so the shared `onCancelSolve` slot is safe to claim here.
    useSolverStore.getState().setOnCancelSolve(() => {
      cancelAssemblySolver()
    })
    // The client slot is single-consumer: unregister on unmount so a stale
    // worker's relay requests no-op instead of being serviced by this (now
    // dead) component's handlers.
    return () => {
      clearRelayHandlers()
      useSolverStore.getState().setOnCancelSolve(null)
    }
  }, [])

  const runSolve = useCallback(async () => {
    const version = solveVersion.current
    const current = docRef.current
    if (!current) return
    const store = useAssemblyStore.getState()
    // A manipulation whose handle names no instance in the current doc is residue
    // from an earlier document (a load raced the drag). Route it back to the
    // ordinary full solve instead of taking the live-drag path against geometry
    // it does not refer to; the error path below then surfaces like any other
    // full-solve failure instead of being swallowed as a quiet live tick.
    let manip = store.manipulation
    if (manip !== null && !findInstance(current, manip.handle)) {
      useAssemblyStore.setState({ manipulation: null, gizmoDrag: null })
      manip = null
    }
    // A drag in progress means a live tick: pin the grabbed part where the
    // pointer put it and let the mates pull the rest. Read fresh each run so the
    // final run after pointer-up (manipulation cleared) is an ordinary full solve.
    const live = manip !== null
    const dragObjective = manip?.dragObjective ?? null
    if (!live) {
      // Mirror into the solver store so LoadingOverlay (mounted in the assembly
      // editor) renders the spinner and cancel button for the full solve; the
      // overlay only reads the solver store.
      useSolverStore.getState().setIsSolving(true)
    } else {
      // A drag is on screen: the spinner must not cover the dragged scene. A
      // solve this live tick superseded skipped its own clear (the version
      // guard in the finally below), so re-arm the mirror off here rather than
      // leave it up for the whole drag.
      useSolverStore.getState().setIsSolving(false)
    }
    try {
      const parts = partSpecs(current)
      let mates = mateSpecs(current)
      if (live && dragObjective) {
        // A body grab: the grabbed part is NOT pinned. A soft drag mate pulls its
        // grab point to the cursor, and it solves alongside the rest, so the pose
        // it comes back with respects the mates -- rigid, never stretched toward a
        // cursor the constraints cannot reach.
        mates = [...mates, dragTargetMate(dragObjective)]
      } else if (live) {
        // A triad gizmo drag: a soft target-pose objective pulls the grabbed
        // part to its drawn world pose (the same livePartPose the render offset
        // and the drag commit read). The part is NOT pinned, so its own mates
        // stay in the solve while the drag is on screen; a hard pin bypassed
        // them until pointer-up, which is the drop-jump this replaces.
        const target = livePartPose(manip!, store.settledPose(manip!.handle))
        mates = [...mates, dragTargetPoseMate(manip!.handle, target)]
      }
      // Hashes are stable across a drag burst; a live tick reuses the last
      // solve's map only while the uuid and the workspace revision still match,
      // so a doc swap or a mid-burst edit invalidates rather than feeding stale
      // keys into the bundle cache.
      const key = hashCacheKey(uuid, workspaceStoreRevision())
      let hashes: Record<string, string>
      if (live && lastHashes.current?.key === key) {
        hashes = lastHashes.current.hashes
      } else {
        if (!burstHashes.current || burstHashes.current.key !== key) {
          burstHashes.current = { key, hashes: await currentHashes(current) }
        }
        hashes = burstHashes.current.hashes
        lastHashes.current = { key, hashes }
      }
      const res = await solveAssemblyViaWorker(uuid, parts, hashes, mates, live)
      if (!res) throw new Error('assembly solver unavailable')
      // Stale-guard: a request that landed while this solve was in flight (undo/
      // redo restoring a doc is the classic case) owns the record. Writing a
      // pre-undo pose here would paint doc A's scene over restored doc B; the
      // queued re-solve makes the right scene, so this result is dropped.
      if (version !== solveVersion.current) return

      if (live) {
        // Drop the grabbed part: it is drawn from its pre-drag mesh under the
        // live offset, so re-posing it here would double the drag delta. It must
        // be dropped from the raw handle-keyed payload before toBodyResults/
        // toEdgeCurves re-key it to `handle:body_i` -- deleting by bare handle
        // after the re-key misses, and the doubled pose is the bug it prevents.
        const grab = manip!.handle
        const transforms = res.payload.transforms
        // Both drag paths solve the grabbed part now (the triad rides a
        // target-pose objective instead of the old hard pin), so fold its SOLVED
        // pose into the session: the render offset draws it there and the commit
        // writes it, BEFORE dropping it from the re-baked set.
        if (transforms[grab]) {
          useAssemblyStore.getState().setDragSolvedPose(transforms[grab])
        }
        delete transforms[grab]
        const payloadBodies = { ...res.payload.bodies }
        delete payloadBodies[grab]
        const bodies = toBodyResults(payloadBodies)
        const edgeCurves = toEdgeCurves(payloadBodies)
        useAssemblyStore.getState().setDragSolveResult({
          transforms,
          bodies,
          edgeCurves,
          solveStatus: liveStatus(res.payload.status),
        })
        return
      }

      const anchors = buildAnchorTable(res.payload.anchors)
      useAssemblyStore.getState().setSolveResult({
        transforms: res.payload.transforms,
        bodies: toBodyResults(res.payload.bodies),
        edgeCurves: toEdgeCurves(res.payload.bodies),
        entityMateRefs: buildEntityMateRefs(res.payload.bodies, res.payload.anchorDescriptors),
        anchors,
        anchorDescriptors: res.payload.anchorDescriptors ?? {},
        pickGeometry: buildPickBodies(res.payload.bodies, anchors),
        // The whole verdict: the per-mate and per-part marks plus the overall
        // status. A mate whose reference no longer resolves comes back in
        // `status.mates`, and that is what turns its row red.
        solveStatus: res.payload.status ?? null,
      })
      // First successful full solve of this assembly. Deferred like useSolver's
      // own, so the callback runs after this solve's state has committed rather
      // than inside the run that produced it.
      if (!firstSolveDone.current && onFirstSolveRef.current) {
        firstSolveDone.current = true
        setTimeout(onFirstSolveRef.current, 0)
      }
    } catch (e) {
      // A failure from a solve a newer request superseded belongs to that older
      // request, not the one the user is waiting on: dropping it keeps a stale
      // banner from painting over a queued re-solve that is about to own the
      // record. A live tick fails quietly regardless: the pointer-up solve is
      // the one that must surface a persistent error, and a per-frame banner
      // would only flicker.
      if (version !== solveVersion.current) return
      // A user cancel (or a watchdog drop of a presumed-stuck worker) is not an
      // error worth a banner - the user asked for it. A worker throw and a Rust
      // overconstrained both arrive through the same `solveStatus` field.
      const reason = extractErrorMessage(e)
      if (!live && !BENIGN_ASSEMBLY_FAILURES.has(reason)) {
        useAssemblyStore.setState({
          solveStatus: {
            verdict: 'failed', residualNorm: 0, rank: 0, dof: 0, iters: 0,
            error: reason, mates: {}, parts: {},
          },
        })
      }
    } finally {
      if (!live) {
        // Only the current solve owns the mirror: a superseded solve (a uuid
        // switch starts a new drain over the old one) must not clear it under
        // the newer solve still in flight. The live branch re-arms it off, so a
        // drag that superseded this solve also ends up cleared.
        if (version === solveVersion.current) {
          useSolverStore.getState().setIsSolving(false)
        }
      }
    }
  }, [uuid])

  const requestSolve = useCallback(() => {
    // Bump the staleness token first: any in-flight solve that captured an
    // older version discards its result rather than painting a stale scene.
    solveVersion.current += 1
    setSolveToken(t => t + 1)
  }, [])

  useEffect(() => {
    // A uuid change drives a different assembly now (the editor remounts keyed
    // by uuid, but a rerender can race the remount): bump the version so any
    // solve the previous uuid left in flight is dropped, and clear the queue and
    // hash cache so the old assembly's data does not carry into the new one.
    if (seenUuidRef.current !== uuid) {
      seenUuidRef.current = uuid
      solveVersion.current += 1
      queued.current = false
      inFlight.current = false
      burstHashes.current = null
      // A different assembly gets its own first solve, exactly as usePartDoc
      // re-arms firstSolveDone across a document swap.
      firstSolveDone.current = false
    }
    if (solveToken === 0) return  // no solve on mount; the caller asks for the first one
    // A request arriving mid-solve queues exactly one follow-up rather than
    // stacking, so a burst of drags collapses into one trailing solve.
    if (inFlight.current) {
      queued.current = true
      return
    }
    inFlight.current = true
    const myUuid = uuid
    const myDrain = ++drainSeq.current
    void (async () => {
      try {
        if (myDrain === drainSeq.current && myUuid === uuidRef.current) await runSolve()
        while (queued.current && myDrain === drainSeq.current && myUuid === uuidRef.current) {
          queued.current = false
          await runSolve()
        }
      } finally {
        // Only the drain that still owns the record may release it. A uuid
        // round-trip can strand an older drain whose uuid matches the current
        // one again, so ownership is proven by the drain id, not the uuid.
        if (myDrain === drainSeq.current) {
          inFlight.current = false
          burstHashes.current = null
        }
      }
    })()
  }, [solveToken, runSolve, uuid])

  // Unmount cleanup: an in-flight solve must not paint into the shared store
  // after the editor is gone, and a remount starts with a fresh version and a
  // clean queue (the shared store survives; the hook's refs do not). Both
  // solving flags are cleared: a hang that never reaches runSolve's finally
  // (the worker never answers) would otherwise leave them up and the overlay
  // stuck. The mount effect's cleanup already clears onCancelSolve.
  useEffect(() => {
    return () => {
      solveVersion.current += 1
      inFlight.current = false
      queued.current = false
      useSolverStore.getState().setIsSolving(false)
    }
  }, [])

  return { requestSolve }
}
