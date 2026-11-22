// The drag shapes shared by the geometry leaves and the editor stores. They
// live beside the rest of the model types so the pure drag math does not have
// to reach into a UI store for a shape it only reads.
import type { GizmoAxisName } from '@/utils/gizmoPickGeometry'

/** Dragging a geometry vertex or whole edge. */
export interface VertexOrEdgeDrag {
  type: 'vertex' | 'edge'
  vertexId: string  // full composite ID (entity ID for edge drags)
  featureId: string
  entityId: string
  vertexKey: string  // "start" | "end" | "center" | "xy" | "edge"
  startWorld: [number, number]
  currentWorld: [number, number]
  startClient: [number, number]  // screen coordinates at pointer-down (for click-vs-drag distinction)
}

/**
 * The triad gesture in progress, published for the renderer. The gesture itself
 * lives in a closure inside the pointer adapter, which React cannot see, so the
 * triad learns which handle is grabbed (and, for a ring, how far it has swung)
 * from here. `axis` is the part-local axis name, not a world vector, so the
 * renderer matches it against GIZMO_AXES without inverse-rotating anything.
 */
export type GizmoDragState =
  | { kind: 'axis'; axis: GizmoAxisName }
  | { kind: 'plane'; axis: GizmoAxisName }
  /**
   * `swing` is the SNAPPED angle the part receives, which is what the dial draws.
   * `snapped` is this frame's outcome; `snapArmed` is whether snapping could
   * happen at all, which the cursor's distance from the ring decides. The dial
   * shows the two differently: a free angle inside the ring still has ticks to
   * fall onto, a disarmed one has none, and the user must be able to see which.
   */
  | {
      kind: 'ring'
      axis: GizmoAxisName
      datum: number
      swing: number
      snapped: boolean
      snapArmed: boolean
    }
