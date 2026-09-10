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
import type { AssemblyDoc, AssemblyFeature, NumberOrExpr, PartDoc } from '@/types/cad'
import { migrateLegacyBodyPicks } from '@/utils/yamlMutations'
import { backendBundle } from '@/adapters/backend'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { buildEntityMateRefs, toBodyResults, toEdgeCurves } from '@/utils/assemblyBodies'
import { buildAnchorTable } from '@/utils/anchorGizmos'
import { buildPickBodies } from '@/utils/assemblyPick'
import { setRelayHandlers, clearRelayHandlers, solveAssemblyViaWorker, cancelAssemblySolver } from '@/kernel/worker/anchorSolverClient'
import { buildBundleViaWorker } from '@/kernel/worker/solverClient'
import type { PartInputSpec } from '@/kernel/worker/solverProtocol'
import type { MateSpec } from '@/kernel/solveAssembly'
import { dragTargetMate } from '@/kernel/assemblyDrag'
import { extractErrorMessage } from '@/kernel/errors'
import { findInstance } from '@/utils/assemblyMutations'
import { livePartPose } from '@/utils/partManipulation'
import { useSolverStore } from '@/stores/solverStore'

// A failure the user walked into is not an error to banner: a cancel kills the
// in-flight solve deliberately, and a watchdog timeout is the same drop of a
// presumed-stuck worker as the part path (`useSolver`'s benign set). Everything
// else is a real failure the user should see.
const BENIGN_ASSEMBLY_FAILURES = new Set(['assembly solve cancelled', 'anchor solver timed out'])

// Monotonic id for non-live solves across EVERY hook instance, the assembly
// flag's counterpart of drainSeq: a previous document's drain can resolve after
// a new editor mounted and started its own solve, and per-instance refs die
// with their owner, so only a module-level counter can prove ownership there.
// Live ticks never bump it, so a drag superseding a full solve keeps today's
// behaviour (the full solve still owns and clears the assembly flag).
let fullSolveSeq = 0

// A mate offset/angle authored as an expression string is not evaluated here;
// expression binding arrives with the mate authoring UI (Stage 8).
function numeric(v: NumberOrExpr | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}

export function partSpecs(doc: AssemblyDoc): PartInputSpec[] {
  return (doc.features ?? [])
    .filter(f => f.kind === 'part_instance' && f.instance)
    .map(f => ({
      handle: f.instance!.handle,
      doc_id: f.instance!.doc_id,
      doc_rev: f.instance!.doc_rev,
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
      ref_a: f.mate!.ref_a,
      ref_b: f.mate!.ref_b,
      flip: f.mate!.flip,
      // Passed through in its authored form, scalar or vector: normalizing it
      // needs the anchor axis, which only resolves inside the solve (see
      // `mateOffsetVector` at solveAssembly.ts's record build).
      offset: f.mate!.offset,
      angle: numeric(f.mate!.angle),
      radius: numeric(f.mate!.radius),
      ratio: f.mate!.ratio,
    }))
}

// The identity the rev cache is keyed to: the uuid plus each referenced part's
// recorded doc_rev, order-insensitive. Any of those changing (a doc swap, or a
// mid-burst edit that bumped a recorded rev) invalidates the cached map so the
// next non-live solve re-fetches instead of committing against a pre-edit bundle.
function revCacheKey(uuid: string, doc: AssemblyDoc): string {
  const parts = partSpecs(doc)
    .map(p => `${p.doc_id}:${p.doc_rev}`)
    .sort()
    .join(',')
  return `${uuid}|${parts}`
}

/**
 * Current revs per referenced part, the bundle cache key. The instance's own
 * `doc_rev` is the rev recorded at placement; a part edited since then has a
 * higher current rev, which is exactly what forces its bundle rebuild.
 */
export async function currentRevs(doc: AssemblyDoc): Promise<Record<string, number>> {
  const parts = partSpecs(doc)
  const revs: Record<string, number> = {}
  for (const p of parts) revs[p.doc_id] = p.doc_rev
  try {
    const summaries = await backendBundle.documents.list()
    for (const s of summaries) {
      if (s.uuid in revs && typeof s.meta?.rev === 'number') revs[s.uuid] = s.meta.rev
    }
  } catch {
    // Store unreachable: fall back to the recorded revs. A stale bundle key can
    // only re-use an older cached bundle, never return wrong geometry.
  }
  return revs
}

export function useAssemblySolve(uuid: string, doc: AssemblyDoc | null) {
  const docRef = useRef<AssemblyDoc | null>(doc)
  docRef.current = doc
  const inFlight = useRef(false)
  const queued = useRef(false)
  // Staleness token, the assembly counterpart of useSolver's requestIdRef: a
  // solve captures the version when it starts and drops its result if a newer
  // request bumped it meanwhile. The assembly worker protocol carries no token,
  // so the guard lives here on the main thread against a local counter.
  const solveVersion = useRef(0)
  // Cached under the identity the revs were computed for (see revCacheKey), so a
  // coalesced burst reuses the map and issues documents.list() once per burst.
  // A doc swap or a mid-burst edit that bumped a recorded rev changes the key,
  // so the next run re-fetches instead of committing against a pre-edit bundle.
  const burstRevs = useRef<{ key: string; revs: Record<string, number> } | null>(null)
  // The rev map from the last full solve. A live drag tick reuses it without a
  // version check: no part is edited mid-drag (applyUndoRedo clears the drag),
  // and re-listing documents per tick is the exact cost this cache avoids.
  const lastRevs = useRef<Record<string, number> | null>(null)
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
        const data = await backendBundle.documents.load(doc_id)
        const doc = (parseYaml(data.content) ?? {}) as PartDoc
        // Same self-heal as the part load seam: a legacy singular transform
        // `body` must reach the OCC worker as the plural `bodies` it reads.
        migrateLegacyBodyPicks(doc)
        return doc as unknown as Record<string, unknown>
      },
      // Stamp the doc id onto the bundle spec: the raw PartDoc YAML carries no
      // id, and solveLocally's cache-reset guard keys on spec.id. Without it,
      // bundle builds of different docs share one checkpoint slot and a bundle
      // build evicts the part editor's incremental cache.
      buildBundle: async (doc_id, doc_rev, spec) =>
        buildBundleViaWorker({ ...spec, id: doc_id }, doc_id, doc_rev),
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
    // The full-solve id this run captures when it starts (0 for live ticks,
    // which never own the assembly flag's clearing).
    let myFullSolve = 0
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
      myFullSolve = ++fullSolveSeq
      store.setIsSolving(true)
      store.setSolveError(null)
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
      let parts = partSpecs(current)
      let mates = mateSpecs(current)
      if (live && dragObjective) {
        // A body grab: the grabbed part is NOT pinned. A soft drag mate pulls its
        // grab point to the cursor, and it solves alongside the rest, so the pose
        // it comes back with respects the mates -- rigid, never stretched toward a
        // cursor the constraints cannot reach.
        mates = [...mates, dragTargetMate(dragObjective)]
      } else if (live) {
        // A triad gizmo drag: pin the grabbed part at its drawn world pose -- the
        // same livePartPose the render offset and the drag commit read -- and mark
        // it fixed, so the solve moves only the others. Its own bodies/transform
        // are left untouched below, so it keeps rendering from its drag offset.
        const pinned = livePartPose(manip!, store.settledPose(manip!.handle))
        parts = parts.map(p => (p.handle === manip!.handle ? { ...p, transform: pinned, fixed: true } : p))
      }
      // Revs are stable across a drag burst; a live tick reuses the last full
      // solve's map. A non-live solve reuses its cached map only while the
      // doc/uuid identity it was computed for is unchanged, so a doc swap or a
      // mid-burst edit that bumped a recorded rev cannot feed stale doc_revs
      // into the bundle cache key.
      let revs: Record<string, number>
      if (live && lastRevs.current) {
        revs = lastRevs.current
      } else {
        const key = revCacheKey(uuid, current)
        if (!burstRevs.current || burstRevs.current.key !== key) {
          burstRevs.current = { key, revs: await currentRevs(current) }
        }
        revs = burstRevs.current.revs
        lastRevs.current = revs
      }
      const res = await solveAssemblyViaWorker(uuid, parts, revs, mates)
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
        // A body grab solves the grabbed part too: fold its SOLVED pose into the
        // session so the render offset draws it there and the commit writes it,
        // BEFORE dropping it from the re-baked set (it renders via that offset).
        if (dragObjective && transforms[grab]) {
          if (version !== solveVersion.current) return
          useAssemblyStore.getState().setDragSolvedPose(transforms[grab])
        }
        delete transforms[grab]
        const payloadBodies = { ...res.payload.bodies }
        delete payloadBodies[grab]
        const bodies = toBodyResults(payloadBodies)
        const edgeCurves = toEdgeCurves(payloadBodies)
        if (version !== solveVersion.current) return
        useAssemblyStore.getState().setDragSolveResult({
          transforms,
          bodies,
          edgeCurves,
          mateResults: res.payload.mateResults ?? {},
        })
        return
      }

      const anchors = buildAnchorTable(res.payload.anchors)
      if (version !== solveVersion.current) return
      useAssemblyStore.getState().setSolveResult({
        transforms: res.payload.transforms,
        bodies: toBodyResults(res.payload.bodies),
        edgeCurves: toEdgeCurves(res.payload.bodies),
        entityMateRefs: buildEntityMateRefs(res.payload.bodies),
        anchors,
        pickGeometry: buildPickBodies(res.payload.bodies, anchors),
        // Keyed by mate feature id. A mate whose reference no longer resolves
        // comes back stale here, and that is the only thing that turns it red.
        mateResults: res.payload.mateResults ?? {},
      })
      // The solve came back, but the mate solver itself trapped and the
      // transforms are the placed seeds. Nothing moved; say why.
      if (res.payload.solveError) {
        useAssemblyStore.getState().setSolveError(res.payload.solveError)
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
      // error worth a banner - the user asked for it.
      const reason = extractErrorMessage(e)
      if (!live && !BENIGN_ASSEMBLY_FAILURES.has(reason)) {
        useAssemblyStore.getState().setSolveError(reason)
      }
    } finally {
      if (!live) {
        // Only the full solve that started LAST may clear the assembly flag:
        // a stale hook instance from a previous document resolving late under
        // a new mount's running solve must not drop the new mount's spinner.
        // A superseding live tick does not bump the sequence, so within one
        // mount the clear stays unconditional exactly as before.
        if (myFullSolve === fullSolveSeq) {
          useAssemblyStore.getState().setIsSolving(false)
        }
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
    // rev cache so the old assembly's data does not carry into the new one.
    if (seenUuidRef.current !== uuid) {
      seenUuidRef.current = uuid
      solveVersion.current += 1
      queued.current = false
      inFlight.current = false
      burstRevs.current = null
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
          burstRevs.current = null
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
      useAssemblyStore.getState().setIsSolving(false)
      useSolverStore.getState().setIsSolving(false)
    }
  }, [])

  return { requestSolve }
}
