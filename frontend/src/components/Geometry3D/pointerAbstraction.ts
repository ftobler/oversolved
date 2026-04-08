import * as THREE from 'three'
import { worldToSketchLocal } from './coordTransform'

/** A pointer event after coordinate sanitization by the abstraction layer.
 *  All downstream consumers (selection subsystem, tool layer) operate on
 *  sketch-local 2D coords and screen pixel coords — never on raw 3D world space.
 *
 *  Produced by sanitizePointerEvent(). Null means the hit point is off-plane. */
export interface SanitizedPointerEvent {
  /** Sketch-local 2D coordinates of the hit point. */
  localPoint: [number, number]
  /** Screen pixel coordinates at event time, used for click-vs-drag disambiguation. */
  clientPoint: [number, number]
}

/** Convert a raw R3F pointer event into a sanitized abstraction-layer event.
 *  Returns null when the hit point is off the sketch plane (|z| > 1), which
 *  indicates the raycast landed on an HTML overlay rather than geometry. */
export function sanitizePointerEvent(
  event: { point: THREE.Vector3; clientX: number; clientY: number },
  groupRef: React.RefObject<THREE.Object3D | null>,
): SanitizedPointerEvent | null {
  const local = worldToSketchLocal(event.point, groupRef)
  if (!local) return null
  return {
    localPoint: local,
    clientPoint: [event.clientX, event.clientY],
  }
}

/** Pixel distance between two screen-space points.
 *  Used for click-vs-drag disambiguation (threshold: CLICK_THRESHOLD_PX). */
export function screenPixelDistance(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}
