import { useMemo } from 'react'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import { measureSingleEntity } from '../registry/measurementRegistry'
import type { Sketch, LineSegment, Arc, Circle, PointEntity } from '../types/cad'

/**
 * Registry component for debugging measurement combinations.
 * Shows which measurement rules could apply to the current selection.
 */
interface RegistryProps {
  sketch: Sketch
}

export function Registry({ sketch }: RegistryProps) {
  const selection = useSketchEditorStore(s => s.selection)

  const measurements = useMemo(() => {
    const results: string[] = []
    for (const id of selection) {
      if (id.startsWith('entity:')) {
        const entityId = id.slice(8)
        const entity = sketch[entityId]
        if (entity) {
          results.push(...measureSingleEntity(entity as LineSegment | Arc | Circle | PointEntity))
        }
      }
    }
    return results
  }, [selection, sketch])

  const matchingRules = useMemo(() => {
    // Get entity types from selection
    const entityTypes = new Set<string>()
    for (const id of selection) {
      if (id.startsWith('entity:')) {
        const entityId = id.slice(8)
        const entity = sketch[entityId]
        if (entity) {
          // Infer type from entity properties
          const e = entity as unknown as Record<string, unknown>
          if ('start' in e && 'end' in e) {
            if ('angle_start' in e) entityTypes.add('arc')
            else entityTypes.add('line')
          } else if ('center' in e && 'radius' in e) {
            if ('angle_start' in e) entityTypes.add('arc')
            else entityTypes.add('circle')
          } else if ('x' in e) {
            entityTypes.add('point')
          }
        }
      }
    }
    return entityTypes
  }, [selection, sketch])

  if (matchingRules.size === 0) {
    return null
  }

  return (
    <div className="registry-display">
      <div className="registry-header">
        <span className="material-icons-outlined">layers</span>
        <span>Measurement Registry</span>
        <span className="match-count">{matchingRules.size} entity type{matchingRules.size > 1 ? 's' : ''}</span>
      </div>

      <div className="registry-body">
        <div className="registry-item active">
          <div className="item-label">Active Measurements</div>
          <div className="item-measurements">
            {measurements.map((m, idx) => (
              <div key={idx} className="measurement">{m}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
