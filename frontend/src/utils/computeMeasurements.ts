import type { Sketch, LineSegment, Arc, Circle, PointEntity } from '../types/cad'
import { measureSingleEntity, measurePair } from '../registry/measurementRegistry'

/**
 * Compute all possible measurement combinations for a set of selected entities.
 * Returns descriptions that can be displayed in the footer.
 *
 * Registry-based approach: rules are ordered by specificity. First match wins.
 * All measurements are displayed (like a selection list).
 */
export function computeMeasurements(
  selection: Set<string>,
  sketch: Sketch
): string[] {
  const results: string[] = []

  // Group selections by entity type
  const lines: LineSegment[] = []
  const arcs: Arc[] = []
  const circles: Circle[] = []
  const points: PointEntity[] = []

  for (const id of selection) {
    if (id.startsWith('@builtin_') || id.startsWith('@feature')) {
      continue
    }

    let entityId: string | undefined
    if (id.startsWith('entity:')) {
      entityId = id.slice(8)
    } else if (id.startsWith('vertex:')) {
      const parts = id.split(':')
      entityId = parts[2]
    } else {
      continue
    }

    if (!entityId) continue

    const entity = sketch[entityId]
    if (!entity) continue

    // Determine entity type by checking which properties exist
    if ('start' in entity && 'end' in entity) {
      const e = entity as unknown as Record<string, unknown>
      const angleProps = e.angle_start
      if (angleProps !== undefined) {
        arcs.push(entity as Arc)
      } else {
        lines.push(entity as LineSegment)
      }
    } else if ('center' in entity && 'radius' in entity) {
      const e = entity as unknown as Record<string, unknown>
      const angleProps = e.angle_start
      if (angleProps === undefined) {
        circles.push(entity as Circle)
      }
    } else if ('x' in entity) {
      points.push(entity as PointEntity)
    }
  }

  // Track entity counts for "no match" message
  const entityCounts = {
    line: lines.length,
    arc: arcs.length,
    circle: circles.length,
    point: points.length,
  }
  const hasValidEntities = Object.values(entityCounts).some(count => count > 0)

  // Use registry to evaluate single-entity measurements
  for (const entity of arcs) {
    const result = measureSingleEntity(entity)
    if (result.length > 0) results.push(...result)
  }
  for (const entity of circles) {
    const result = measureSingleEntity(entity)
    if (result.length > 0) results.push(...result)
  }
  for (const entity of lines) {
    const result = measureSingleEntity(entity)
    if (result.length > 0) results.push(...result)
  }
  for (const entity of points) {
    const result = measureSingleEntity(entity)
    if (result.length > 0) results.push(...result)
  }

  // Multi-entity measurements: try all pairs
  const allEntities: Array<{ type: string; entity: LineSegment | Arc | Circle | PointEntity }> = [
    ...arcs.map(e => ({ type: 'arc', entity: e })),
    ...circles.map(e => ({ type: 'circle', entity: e })),
    ...lines.map(e => ({ type: 'line', entity: e })),
    ...points.map(e => ({ type: 'point', entity: e })),
  ]

  for (let i = 0; i < allEntities.length; i++) {
    for (let j = i + 1; j < allEntities.length; j++) {
      const e1 = allEntities[i]
      const e2 = allEntities[j]
      const result = measurePair({
        [e1.type]: e1.entity,
        [e2.type]: e2.entity,
      })
      if (result.length > 0) results.push(...result)
    }
  }

  // If we have valid entities but no measurements matched, show a descriptive message
  if (hasValidEntities && results.length === 0) {
    const parts: string[] = []
    if (entityCounts.line > 0) parts.push(`${entityCounts.line}x line`)
    if (entityCounts.arc > 0) parts.push(`${entityCounts.arc}x arc`)
    if (entityCounts.circle > 0) parts.push(`${entityCounts.circle}x circle`)
    if (entityCounts.point > 0) parts.push(`${entityCounts.point}x point`)
    results.push(`No match for ${parts.join(', ')}`)
  }

  return results
}
