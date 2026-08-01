import { describe, it, expect } from 'vitest'
import { isProjectedEntity } from '@/types/cad'
import type { Entity } from '@/types/cad'

// EntityLines filters out projected entities from the interactive entity list.
// This is the drag guard: projected entities are rendered non-interactively
// and cannot be dragged.  The filter is:
//   .filter(([, entity]) => !(entity as { projected?: boolean }).projected)
//
// These tests verify that the guard logic correctly identifies projected entities
// so drag initiation can be blocked upstream.

function isEntityDraggable(entity: Entity): boolean {
  // Mirrors the filter in EntityLines.tsx: entities with projected=true
  // are excluded from the interactive list and therefore not draggable.
  return !isProjectedEntity(entity)
}

describe('projected entity drag guard', () => {
  it('allows dragging a regular line', () => {
    const line: Entity = { start: [0, 0], end: [1, 1] }
    expect(isEntityDraggable(line)).toBe(true)
  })

  it('allows dragging a regular circle', () => {
    const circle: Entity = { center: [0, 0], radius: 1 }
    expect(isEntityDraggable(circle)).toBe(true)
  })

  it('allows dragging a regular arc', () => {
    const arc: Entity = {
      center: [0, 0], radius: 1,
      angle_start: 0, angle_end: 90,
      start: [1, 0], end: [0, 1],
    }
    expect(isEntityDraggable(arc)).toBe(true)
  })

  it('allows dragging a regular point', () => {
    const pt: Entity = { x: 0, y: 0 }
    expect(isEntityDraggable(pt)).toBe(true)
  })

  it('blocks dragging a projected line (has projected: true)', () => {
    const projLine: Entity = {
      start: [0, 0], end: [1, 1],
      projected: true,
      source: '@sketch0/line1',
    }
    expect(isEntityDraggable(projLine)).toBe(false)
  })

  it('blocks dragging a projected circle', () => {
    const projCircle: Entity = {
      center: [0, 0], radius: 1,
      projected: true,
      source: '@sketch0/circle1',
    }
    expect(isEntityDraggable(projCircle)).toBe(false)
  })

  it('blocks dragging a projected arc', () => {
    const projArc: Entity = {
      center: [0, 0], radius: 1,
      angle_start: 0, angle_end: 90,
      start: [1, 0], end: [0, 1],
      projected: true,
      source: '@sketch0/arc1',
    }
    expect(isEntityDraggable(projArc)).toBe(false)
  })

  it('blocks dragging a projected point', () => {
    const projPt: Entity = {
      x: 2, y: 3,
      projected: true,
      source: '@sketch0/point1',
    }
    expect(isEntityDraggable(projPt)).toBe(false)
  })

  it('isProjectedEntity returns false for entities without projected flag', () => {
    const line: Entity = { start: [0, 0], end: [1, 1] }
    expect(isProjectedEntity(line)).toBe(false)
  })

  it('isProjectedEntity returns true for entities with projected=true', () => {
    const projLine: Entity = {
      start: [0, 0], end: [1, 1],
      projected: true,
      source: '@sketch0/line1',
    }
    expect(isProjectedEntity(projLine)).toBe(true)
  })
})
