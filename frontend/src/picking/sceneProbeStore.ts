// The live scene probe: module state published by the viewport, read by the
// future dev bridge. React-free and three-free so it can be driven and unit
// tested headlessly; the only browser dependency is the DOM handle scan, which
// is skipped when there is no document.

import {
  buildSceneProbe, hitTest, probeCamerasEqual,
  type ProbeCamera, type ProbeHit, type ProbeHitOptions,
  type ProbePickableSource, type ProbePlane, type SceneProbe,
} from './sceneProbe'
import { scanDomHandles } from './domHandles'

interface ProbeStoreState {
  revision: number
  camera: ProbeCamera | null
  canvas: { width: number; height: number }
  sketchPlane: ProbePlane | null
  // One slot per publisher (a sketch, one dimension label, ...); replacing a
  // slot keeps its insertion position, so pickable order is stable across
  // re-registrations.
  sources: Map<string, ReadonlyArray<ProbePickableSource>>
}

function freshState(): ProbeStoreState {
  return {
    revision: 0,
    camera: null,
    canvas: { width: 0, height: 0 },
    sketchPlane: null,
    sources: new Map(),
  }
}

let state = freshState()

/** Source key builders, so publishers and removers cannot disagree. */
export const probeSourceKeys = {
  sketch: (featureId: string) => `sketch:${featureId}`,
  surface: (featureId: string) => `surface:${featureId}`,
  origin: (selectionId: string) => `origin:${selectionId}`,
  dimensionLabel: (entityKey: string) => `dim:${entityKey}`,
  featureHandle: (entityKey: string) => `fhandle:${entityKey}`,
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function planesEqual(a: ProbePlane | null, b: ProbePlane | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return arraysEqual(a.rotation, b.rotation) && arraysEqual(a.origin, b.origin)
}

/**
 * Publish the camera pose. Equal publishes are no-ops, so a driver polling
 * every frame records only actual changes.
 */
export function publishProbeCamera(camera: ProbeCamera | null): void {
  if (probeCamerasEqual(state.camera, camera)) return
  state.camera = camera
  state.revision++
}

/** Publish the main canvas size in CSS pixels; equal publishes are no-ops. */
export function publishProbeCanvas(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return
  if (state.canvas.width === width && state.canvas.height === height) return
  state.canvas = { width, height }
  state.revision++
}

/** Publish which sketch plane the active sketch edits in; equal is a no-op. */
export function publishProbeSketchPlane(plane: ProbePlane | null): void {
  if (planesEqual(state.sketchPlane, plane)) return
  state.sketchPlane = plane
  state.revision++
}

/** Replace one publisher's pickables (a sketch, one label, one handle). */
export function replaceProbeSource(
  sourceKey: string, pickables: ReadonlyArray<ProbePickableSource>,
): void {
  state.sources.set(sourceKey, pickables)
  state.revision++
}

/** Drop one publisher's pickables; a clear of an empty slot is a no-op. */
export function clearProbeSource(sourceKey: string): void {
  if (state.sources.delete(sourceKey)) state.revision++
}

function collectPickables(): ProbePickableSource[] {
  const out: ProbePickableSource[] = []
  for (const pickables of state.sources.values()) out.push(...pickables)
  return out
}

/** The JSON-safe probe snapshot, projected through the current camera. */
export function getSceneProbe(): SceneProbe {
  return buildSceneProbe({
    revision: state.revision,
    camera: state.camera,
    canvas: state.canvas,
    sketchPlane: state.sketchPlane,
    pickables: collectPickables(),
  })
}

/** `hitTest` against the live probe, for the dev bridge and tests. */
export function probeHitTest(x: number, y: number, opts?: ProbeHitOptions): ProbeHit[] {
  return hitTest(getSceneProbe(), x, y, opts)
}

export function getSceneProbeRevision(): number {
  return state.revision
}

export interface ProbeHandle {
  kind: 'gl' | 'dom'
  // GL: the per-primitive pickKey. DOM: the data-oversolved-handle value.
  handle: string
  entityKey?: string
  layer?: string
  screenPoints?: [number, number][]
  // DOM only: client rect [x, y, width, height] in CSS pixels.
  rect?: [number, number, number, number]
}

/**
 * Every named hit target: the GL pickables from the probe plus the DOM
 * controls the attribute scan finds. `prefix` filters both by handle id.
 */
export function getSceneHandles(prefix?: string): ProbeHandle[] {
  const matches = (handle: string) => prefix === undefined || handle.startsWith(prefix)
  const out: ProbeHandle[] = []
  for (const pickable of getSceneProbe().pickables) {
    if (!matches(pickable.pickKey)) continue
    out.push({
      kind: 'gl',
      handle: pickable.pickKey,
      entityKey: pickable.entityKey,
      layer: pickable.layer,
      screenPoints: pickable.screenPoints,
    })
  }
  if (typeof document !== 'undefined') {
    for (const dom of scanDomHandles(document)) {
      if (!matches(dom.handle)) continue
      out.push({ kind: 'dom', handle: dom.handle, rect: dom.rect })
    }
  }
  return out
}

/** Test seam: forget everything published so far. */
export function resetSceneProbeStore(): void {
  state = freshState()
}
