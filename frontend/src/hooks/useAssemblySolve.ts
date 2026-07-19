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
import type { AssemblyDoc, AssemblyFeature, NumberOrExpr } from '@/types/cad'
import { backendBundle } from '@/adapters/backend'
import { loadDocumentAnyDomain } from '@/adapters/documentLoad'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { buildEntityMateRefs, toBodyResults, toEdgeCurves } from '@/utils/assemblyBodies'
import { buildAnchorTable } from '@/utils/anchorGizmos'
import { buildPickBodies } from '@/utils/assemblyPick'
import { setRelayHandlers, solveAssemblyViaWorker } from '@/kernel/worker/anchorSolverClient'
import { buildBundleViaWorker } from '@/kernel/worker/solverClient'
import type { PartInputSpec } from '@/kernel/worker/solverProtocol'
import type { MateSpec } from '@/kernel/solveAssembly'
import { extractErrorMessage } from '@/kernel/errors'
import { livePartPose, settledTransforms } from '@/utils/partManipulation'

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
  // Cached for one coalesced burst (see the effect below) so a trailing
  // queued solve reuses the rev map instead of re-issuing `documents.list()`.
  // Cleared once the burst drains, so the next burst reads fresh revs.
  const burstRevs = useRef<Record<string, number> | null>(null)
  // The rev map from the last full solve. A live drag tick reuses it rather than
  // re-listing documents: no part is edited mid-drag, so the bundles are all
  // cache hits and a solve stays OCC-free and fast.
  const lastRevs = useRef<Record<string, number> | null>(null)
  // A solve is requested by bumping a token, never by calling runSolve inline:
  // callers ask for it in the same event that mutates the doc (a drag commit
  // writes the transform, then re-solves), and the mutated doc only reaches
  // docRef on the next render. Reading it from an effect keeps the solve from
  // running against the pose the user just moved away from.
  const [solveToken, setSolveToken] = useState(0)

  useEffect(() => {
    setRelayHandlers({
      partDocContent: async (doc_id) => {
        // A part picked from the cloud category has no local mirror; the shared
        // resolver falls back to the cloud domain for it.
        const { data } = await loadDocumentAnyDomain(doc_id)
        return (parseYaml(data.content) ?? {}) as Record<string, unknown>
      },
      buildBundle: async (doc_id, doc_rev, spec) => buildBundleViaWorker(spec, doc_id, doc_rev),
    })
  }, [])

  const runSolve = useCallback(async () => {
    const current = docRef.current
    if (!current) return
    const store = useAssemblyStore.getState()
    // A drag in progress means a live tick: pin the grabbed part where the
    // pointer put it and let the mates pull the rest. Read fresh each run so the
    // final run after pointer-up (manipulation cleared) is an ordinary full solve.
    const manip = store.manipulation
    const live = manip !== null
    if (!live) {
      store.setIsSolving(true)
      store.setSolveError(null)
    }
    try {
      let parts = partSpecs(current)
      if (live) {
        // Pin the grabbed part at its drawn world pose -- the same livePartPose
        // the render offset and the drag commit read -- and mark it fixed, so the
        // solve moves only the others. Its own bodies/transform are left
        // untouched below, so it keeps rendering from its drag offset.
        const settled = settledTransforms(store.transforms, store.settlingOffsets)
        const pinned = livePartPose(manip!, settled[manip!.handle])
        parts = parts.map(p => (p.handle === manip!.handle ? { ...p, transform: pinned, fixed: true } : p))
      }
      // Revs are stable across a drag burst; a live tick reuses the last full
      // solve's map, the standard burst reads once and caches it.
      let revs: Record<string, number>
      if (live && lastRevs.current) {
        revs = lastRevs.current
      } else {
        if (!burstRevs.current) burstRevs.current = await currentRevs(current)
        revs = burstRevs.current
        lastRevs.current = revs
      }
      const res = await solveAssemblyViaWorker(uuid, parts, revs, mateSpecs(current))
      if (!res) throw new Error('assembly solver unavailable')

      if (live) {
        // Drop the grabbed part: it is drawn from its pre-drag mesh under the
        // live offset, so re-posing it here would double the drag delta. It must
        // be dropped from the raw handle-keyed payload before toBodyResults/
        // toEdgeCurves re-key it to `handle:body_i` -- deleting by bare handle
        // after the re-key misses, and the doubled pose is the bug it prevents.
        const grab = manip!.handle
        const transforms = res.payload.transforms
        delete transforms[grab]
        const payloadBodies = { ...res.payload.bodies }
        delete payloadBodies[grab]
        const bodies = toBodyResults(payloadBodies)
        const edgeCurves = toEdgeCurves(payloadBodies)
        useAssemblyStore.getState().setDragSolveResult({
          transforms,
          bodies,
          edgeCurves,
          mateResults: res.payload.mateResults ?? {},
        })
        return
      }

      const anchors = buildAnchorTable(res.payload.anchors)
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
      // A live tick fails quietly: the pointer-up solve is the one that must
      // surface a persistent error, and a per-frame banner would only flicker.
      if (!live) useAssemblyStore.getState().setSolveError(extractErrorMessage(e))
    } finally {
      if (!live) useAssemblyStore.getState().setIsSolving(false)
    }
  }, [uuid])

  const requestSolve = useCallback(() => setSolveToken(t => t + 1), [])

  useEffect(() => {
    if (solveToken === 0) return  // no solve on mount; the caller asks for the first one
    // A request arriving mid-solve queues exactly one follow-up rather than
    // stacking, so a burst of drags collapses into one trailing solve.
    if (inFlight.current) {
      queued.current = true
      return
    }
    inFlight.current = true
    void (async () => {
      try {
        await runSolve()
        while (queued.current) {
          queued.current = false
          await runSolve()
        }
      } finally {
        inFlight.current = false
        burstRevs.current = null
      }
    })()
  }, [solveToken, runSolve])

  return { requestSolve }
}
