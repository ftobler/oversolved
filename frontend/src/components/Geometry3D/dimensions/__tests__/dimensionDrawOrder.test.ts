import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { WebGLRenderList } from 'three/src/renderers/webgl/WebGLRenderLists.js'
import { LineMaterial } from 'three-stdlib'
import { dimensionRenderLayer } from '@/components/Geometry3D/constants'
import { RENDER_ORDER_DEFAULT } from '@/utils/core/partColors'

/**
 * Pins the user's failure mode at the layer three actually sorts with. The
 * opaque pass orders by renderOrder first and material.id only as a tie-break,
 * so a dimension whose material was created before the body's (what a body
 * remount during a solve produces) loses to the body when both sit at
 * renderOrder 0, and wins once the dimension carries the edit layer. Running
 * through three's own WebGLRenderList keeps this a statement about the
 * renderer, not about our idea of the renderer.
 */

// three's runtime constructor takes no arguments; DefinitelyTyped still
// declares the properties registry it stopped reading.
function renderList() {
  return new WebGLRenderList(undefined as never)
}

// Material.id comes from a creation counter at runtime; @types/three no longer
// declares it, but the sort tie-break is exactly what this test is about.
function materialId(material: THREE.Material): number {
  return (material as unknown as { id: number }).id
}

function sortedOpaque(dimensionRenderOrder: number) {
  // The dimension material is created first on purpose: that is the id that
  // used to win the tie-break, and the shape of the reported bug.
  const dimensionMaterial = new LineMaterial({ color: 0xffffff })
  const dimension = new THREE.Line(new THREE.BufferGeometry(), dimensionMaterial)
  dimension.renderOrder = dimensionRenderOrder

  const bodyMaterial = new THREE.MeshPhysicalMaterial()
  const body = new THREE.Mesh(new THREE.BoxGeometry(), bodyMaterial)

  const list = renderList()
  list.push(dimension, dimension.geometry, dimensionMaterial, 0, 50, null)
  list.push(body, body.geometry, bodyMaterial, 0, 10, null)
  list.sort(undefined as never, undefined as never)

  expect(materialId(dimensionMaterial)).toBeLessThan(materialId(bodyMaterial))
  return list.opaque.map(item => item.object)
}

describe('dimension draw order', () => {
  it('draws the dimension after the body even when the body material is newer', () => {
    const order = sortedOpaque(dimensionRenderLayer().renderOrder)

    expect(order).toHaveLength(2)
    expect(order[1]).toBeInstanceOf(THREE.Line)
    expect(order[0]).toBeInstanceOf(THREE.Mesh)
  })

  it('documents the old failure: at the body layer the newer body material paints last', () => {
    const order = sortedOpaque(RENDER_ORDER_DEFAULT)

    expect(order).toHaveLength(2)
    expect(order[1]).toBeInstanceOf(THREE.Mesh)
    expect(order[0]).toBeInstanceOf(THREE.Line)
  })
})
