// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/drag-topology-staleness.md.
import type { Sketch } from '@/types/cad'

/**
 * Whether the sketch topology (area surfaces + free curve-curve intersection
 * points) is stale relative to what is currently rendered.
 *
 * The WASM drag fast-path rewrites only per-entity geometry every rAF frame;
 * the Rust area builder runs only on the cold solve. So during a drag, and
 * during the brief window after pointer-up before the cold solve lands, the
 * `topology` prop still describes the PRE-drag sketch. Renderers that build
 * off `topology` (`TopologySurfaces`, `InferredContactMarkers`,
 * `useSketchSurfaceIdRegistration`) would draw a self-intersecting area fill,
 * and the snap scan / ID registration would offer `isect:` candidates baked at
 * the pre-drag crossing position -- a hazard that can drop a coincident onto
 * an element that is visually no longer there (feature/drag-topology-staleness.md).
 *
 * Two conditions mark topology stale:
 *  1. `isDraggingThis` -- a geometry-moving drag (vertex or edge) is active on
 *     THIS sketch (the WASM drag preview is moving geometry; topology has not).
 *     The caller is responsible for narrowing this flag to geometry-moving
 *     drags -- a `dim_label` drag does not move geometry, so its caller
 *     (`Geometry3D/index.tsx`) passes `isDraggingThis && drag?.type !== 'dim_label'`.
 *  2. `nextHeld` is the post-drag held preview and is NOT the same reference as
 *     the fresh `solved`. `Geometry3D` swaps `nextHeld` for `solved` once the
 *     cold solve's fresh Sketch arrives; identity-cmp against `solved` is the
 *     existing convention (see `Geometry3D/index.tsx` held/preview tracker).
 *
 * Architectural rule: while stale, callers treat `topology` as `undefined`
 * for snap/ID purposes (`useSketchIdRegistration`, `DragPlane`), and suppress
 * `TopologySurfaces` / `useSketchSurfaceIdRegistration` / `InferredContactMarkers`
 * render entirely. The `dock:` half of the inferred-contact set
 * (`sketchToDockCandidates`, derived from live `sketch + constraints + params`)
 * stays valid during a drag and IS still offered; only the `isect:` half reads
 * the stale topology.
 */
export function topologyStale(
  isDraggingThis: boolean,
  nextHeld: Sketch | null,
  solved: Sketch,
): boolean {
  if (isDraggingThis) return true
  if (nextHeld !== null && nextHeld !== solved) return true
  return false
}