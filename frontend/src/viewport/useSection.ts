// The React half of the section view: resolve the source against the live
// solve, keep the shared clipping plane in step, and tell the viewport when to
// repaint and re-render the pick buffer.
//
// The plane itself lives in `viewport/sectionClipping.ts`; everything here is
// wiring so the renderer-free pieces stay testable on their own.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking/IdPipelineContext'
import { findFaceFrame } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { SECTION_SOURCE_GONE_REASON, useSectionStore } from '@/stores/sectionStore'
import type { SketchData } from '@/types/cad'
import {
  resolveSectionFrame,
  sectionPlaneFromFrame,
  type SectionFrame,
} from '@/viewport/sectionPlane'
import { applySectionClipping, setSectionClipPlane } from '@/viewport/sectionClipping'

/**
 * The frame the section's source names right now, or null when a picked plane
 * or face no longer resolves. Recomputed when the solve result changes, which
 * is what makes a deleted plane turn the section off instead of leaving it
 * clipping against stale geometry.
 */
export function useSectionFrame(): SectionFrame | null {
  const source = useSectionStore(s => s.plane)
  const solveResults = usePartEditorStore(s => s.solveResults) as Record<string, SketchData> | undefined
  return useMemo(() => resolveSectionFrame(source, {
    planeTransform: query => solveResults?.[query]?.plane_transform ?? null,
    faceFrame: query => {
      const frame = findFaceFrame(query, undefined)
      return frame ? { normal: frame.normal, point: frame.center } : null
    },
  }), [source, solveResults])
}

export interface SectionClipState {
  // The section is on and its plane resolves: the clipped materials carry it.
  active: boolean
  frame: SectionFrame | null
  offset: number
  flipped: boolean
}

/**
 * Resolve the section and publish its plane to the one shared instance. Every
 * clipped component calls this; the layout effect makes the plane current
 * before the frame the store change already requested is drawn.
 */
export function useSectionClip(): SectionClipState {
  const enabled = useSectionStore(s => s.enabled)
  const offset = useSectionStore(s => s.offset)
  const flipped = useSectionStore(s => s.flipped)
  const frame = useSectionFrame()
  const active = enabled && frame !== null

  useLayoutEffect(() => {
    setSectionClipPlane(active && frame ? sectionPlaneFromFrame(frame, offset, flipped) : null)
  }, [active, frame, offset, flipped])

  return { active, frame, offset, flipped }
}

/** Attach the section's clip plane to a material held in a ref. */
export function useSectionMaterialClipping(
  materialRef: RefObject<THREE.Material | null>,
  active: boolean,
): void {
  useLayoutEffect(() => {
    applySectionClipping(materialRef.current, active)
  }, [materialRef, active])
}

/** Same, for a material whose identity this component owns (a memo result). */
export function useSectionOwnedMaterialClipping(
  material: THREE.Material | null | undefined,
  active: boolean,
): void {
  useLayoutEffect(() => {
    applySectionClipping(material, active)
  }, [material, active])
}

/** Switch the ID pipeline's clip + cap machinery on or off. */
export function useSectionPipelineState(active: boolean): void {
  useEffect(() => {
    getLivePipeline()?.setSectionActive(active)
  }, [active])
}

/**
 * The section's debt to the ID buffer, in the same shape as
 * `viewOptionsEffects`: moving, flipping or toggling the section changes the
 * pick image without a camera move, so dirty the buffer and drop the hover that
 * was resolved against the old cut. `clearHover` also invalidates the
 * scheduler's in-flight resolve, so a readback launched a frame earlier cannot
 * resurrect a highlight for a pixel that is now cut away.
 */
export interface SectionChangeTarget {
  markDirty: (reason?: string) => void
  clearHover: () => void
}

export function notifySectionChange(target: SectionChangeTarget): void {
  target.markDirty('section')
  target.clearHover()
}

/**
 * Track every change that moves or toggles the cut. The first render is
 * skipped: mounting does not change the cut, and the registration hooks already
 * dirty the buffer for their own initial state.
 */
export function useSectionPipelineEffects(clearHover: () => void): void {
  const enabled = useSectionStore(s => s.enabled)
  const source = useSectionStore(s => s.plane)
  const offset = useSectionStore(s => s.offset)
  const flipped = useSectionStore(s => s.flipped)
  const { active, frame } = useSectionClip()
  const mounted = useRef(false)

  // A builtin frame never moves, so only a query's frame is worth a dependency:
  // otherwise every solve would dirty the pick buffer for a section that did
  // not change.
  const frameDependency = source.kind === 'query' ? frame : null

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    notifySectionChange({
      markDirty: reason => getLivePipeline()?.markDirty(reason),
      clearHover,
    })
    // The frame is in the deps because a solve can move a picked user plane
    // without any store field changing.
  }, [enabled, source, offset, flipped, frameDependency, clearHover])

  useEffect(() => {
    if (enabled && frame === null) useSectionStore.getState().disable(SECTION_SOURCE_GONE_REASON)
  }, [enabled, frame])

  useSectionPipelineState(active)
}
