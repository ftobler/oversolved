import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  SECTION_CAP_FILL_ORDER,
  SECTION_CAP_SIZE,
  SECTION_CAP_STENCIL_BACK_ORDER,
  SECTION_CAP_STENCIL_FRONT_ORDER,
  buildSectionCapFillMaterial,
  buildSectionCapStencilMaterial,
  placeSectionCapQuad,
} from '@/components/Geometry3D/sectionCaps'

interface SectionCapProps {
  // The body's own surface geometry. The stencil passes draw the same triangles
  // the body does, so the cut silhouette matches the visible solid exactly.
  geometry: THREE.BufferGeometry
  color: string
  enabled: boolean
}

/**
 * One body's stencil cap. Mounted inside the body's group only while a section
 * is on, and rendered after the body. `onBeforeRender` clears the stencil for
 * this body and `onAfterRender` clears it again, so bodies cannot accumulate a
 * count from each other.
 */
export default function SectionCap({ geometry, color, enabled }: SectionCapProps) {
  const [backMaterial] = useState(() => buildSectionCapStencilMaterial(THREE.BackSide))
  const [frontMaterial] = useState(() => buildSectionCapStencilMaterial(THREE.FrontSide))
  const [fillMaterial] = useState(() => buildSectionCapFillMaterial(color))
  const [quadGeometry] = useState(() => new THREE.PlaneGeometry(SECTION_CAP_SIZE, SECTION_CAP_SIZE))
  const quadRef = useRef<THREE.Mesh>(null)

  // The fill wears the body's current colour; a part colour edit repaints the
  // cap without rebuilding the stencil materials.
  useEffect(() => { fillMaterial.color.set(color) }, [fillMaterial, color])

  useEffect(() => () => {
    backMaterial.dispose()
    frontMaterial.dispose()
    fillMaterial.dispose()
    quadGeometry.dispose()
  }, [backMaterial, frontMaterial, fillMaterial, quadGeometry])

  if (!enabled) return null

  return (
    <group>
      <mesh
        geometry={geometry}
        material={backMaterial}
        renderOrder={SECTION_CAP_STENCIL_BACK_ORDER}
        onBeforeRender={renderer => { renderer.clearStencil() }}
      />
      <mesh
        geometry={geometry}
        material={frontMaterial}
        renderOrder={SECTION_CAP_STENCIL_FRONT_ORDER}
      />
      <mesh
        ref={quadRef}
        geometry={quadGeometry}
        material={fillMaterial}
        renderOrder={SECTION_CAP_FILL_ORDER}
        onBeforeRender={() => { if (quadRef.current) placeSectionCapQuad(quadRef.current) }}
        onAfterRender={renderer => { renderer.clearStencil() }}
        raycast={() => undefined}
      />
    </group>
  )
}
