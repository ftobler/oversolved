// snapHooks.ts
// Shared hooks for snap and alignment detection used by dragging and drawing.
//
// Implements utilities for feature_dynamic_select.md and feature_entity_snap.md:
// - useDynamicSelectionPositions: Maps selection IDs to world positions for alignment detection
// - Supports kinda_horizontal/kinda_vertical snapping by providing reference points

import { useMemo } from 'react'
import type { Sketch, LineSegment, Circle, Arc, PointEntity } from '@/types/cad'

/**
 * Build a map from selection ID to world position for alignment snap detection.
 *
 * Used by both DragPlane and DrawPlane to detect kinda_horizontal/kinda_vertical
 * alignment snaps relative to already-selected geometry.
 */
export function useDynamicSelectionPositions(
  sketch: Sketch | undefined,
  dynamicSelection: Set<string>,
): Map<string, [number, number]> {
  return useMemo(() => {
    const pos = new Map<string, [number, number]>()
    if (!sketch) return pos
    for (const id of dynamicSelection) {
      if (id.startsWith('vertex:')) {
        // Format: vertex:featureId:entityId:key
        const parts = id.split(':')
        if (parts.length >= 4) {
          const [, , entityId, vertexKey] = parts
          const entity = sketch[entityId]
          if (entity) {
            if ('start' in entity && 'end' in entity) {
              const lineEntity = entity as LineSegment | Arc
              if (vertexKey === 'start') pos.set(id, lineEntity.start)
              else if (vertexKey === 'end') pos.set(id, lineEntity.end)
              else if (vertexKey === 'center' && 'radius' in entity) pos.set(id, (entity as Arc).center)
            } else if ('center' in entity && vertexKey === 'center') {
              pos.set(id, (entity as Circle).center)
            } else if ('x' in entity && vertexKey === 'xy') {
              const ptEntity = entity as PointEntity
              pos.set(id, [ptEntity.x, ptEntity.y])
            }
          }
        }
      } else if (id.startsWith('entity:')) {
        // Use entity center for entity references
        const parts = id.split(':')
        if (parts.length >= 3) {
          const [, , entityId] = parts
          const entity = sketch[entityId]
          if (entity) {
            if ('start' in entity && 'end' in entity) {
              const mid: [number, number] = [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2]
              pos.set(id, mid)
            } else if ('center' in entity) {
              pos.set(id, (entity as Circle).center)
            }
          }
        }
      }
    }
    return pos
  }, [dynamicSelection, sketch])
}
