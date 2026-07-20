// Draws the assembly's B-rep selection and hover, mode-gated by the viewport so
// it never shows while a mate field is armed (that mode has its own anchor
// gizmos). The geometry is pulled from `pickGeometry` in solved-pose world
// coordinates by a pure helper, so this component only turns Float32Arrays into
// three.js buffers and picks the highlight colours -- the part editor's
// COLOR_SELECTED / COLOR_HOVER, so the two editors read the same.

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { COLOR_SELECTED, COLOR_HOVER, RENDER_ORDER_HIGHLIGHT } from '@/components/Geometry3D/constants'
import { buildAssemblySelectionGeometry } from '@/utils/assemblySelectionGeometry'
import type { AssemblyPickBody } from '@/utils/assemblyPick'
import type { Vec3 } from '@/utils/transform3d'

interface Props {
  pickBodies: readonly AssemblyPickBody[]
  selection: ReadonlySet<string>
  hovered: string | null
}

// A no-op raycast keeps R3F from ever hitting these visual-only overlays.
const NO_RAYCAST = () => undefined

function useTriMesh(positions: Float32Array): THREE.BufferGeometry | null {
  const geo = useMemo(() => {
    if (positions.length === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [positions])
  useEffect(() => () => geo?.dispose(), [geo])
  return geo
}

function usePointsGeometry(points: readonly Vec3[]): THREE.BufferGeometry | null {
  const geo = useMemo(() => {
    if (points.length === 0) return null
    const arr = new Float32Array(points.length * 3)
    points.forEach((p, i) => { arr[i * 3] = p[0]; arr[i * 3 + 1] = p[1]; arr[i * 3 + 2] = p[2] })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    return g
  }, [points])
  useEffect(() => () => geo?.dispose(), [geo])
  return geo
}

export default function AssemblySelectionHighlight({ pickBodies, selection, hovered }: Props) {
  const geometry = useMemo(
    () => buildAssemblySelectionGeometry(pickBodies, selection, hovered),
    [pickBodies, selection, hovered],
  )

  const selFaces = useTriMesh(geometry.selectedFaces)
  const hovFaces = useTriMesh(geometry.hoveredFaces)
  const selFaceBoundary = useTriMesh(geometry.selectedFaceBoundary)
  const hovFaceBoundary = useTriMesh(geometry.hoveredFaceBoundary)
  const selEdges = useTriMesh(geometry.selectedEdges)
  const hovEdges = useTriMesh(geometry.hoveredEdges)
  const selVerts = usePointsGeometry(geometry.selectedVertices)
  const hovVerts = usePointsGeometry(geometry.hoveredVertices)

  // Picking is the ID buffer's job, never R3F raycasting: these overlays sit on
  // top and must not intercept the grab ray meant for the body beneath, nor turn
  // an empty-space click into a hit that suppresses the deselect.
  return (
    <group renderOrder={RENDER_ORDER_HIGHLIGHT}>
      {selFaces && (
        <mesh geometry={selFaces} renderOrder={RENDER_ORDER_HIGHLIGHT} raycast={NO_RAYCAST}>
          <meshBasicMaterial
            color={COLOR_SELECTED}
            transparent
            opacity={0.35}
            side={THREE.DoubleSide}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      )}
      {hovFaces && (
        <mesh geometry={hovFaces} renderOrder={RENDER_ORDER_HIGHLIGHT} raycast={NO_RAYCAST}>
          <meshBasicMaterial
            color={COLOR_HOVER}
            transparent
            opacity={0.2}
            side={THREE.DoubleSide}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      )}
      {selFaceBoundary && (
        <lineSegments geometry={selFaceBoundary} renderOrder={RENDER_ORDER_HIGHLIGHT} raycast={NO_RAYCAST}>
          <lineBasicMaterial color={COLOR_SELECTED} depthTest={false} transparent />
        </lineSegments>
      )}
      {hovFaceBoundary && (
        <lineSegments geometry={hovFaceBoundary} renderOrder={RENDER_ORDER_HIGHLIGHT} raycast={NO_RAYCAST}>
          <lineBasicMaterial color={COLOR_HOVER} depthTest={false} transparent />
        </lineSegments>
      )}
      {selEdges && (
        <lineSegments geometry={selEdges} renderOrder={RENDER_ORDER_HIGHLIGHT} raycast={NO_RAYCAST}>
          <lineBasicMaterial color={COLOR_SELECTED} depthTest={false} transparent />
        </lineSegments>
      )}
      {hovEdges && (
        <lineSegments geometry={hovEdges} renderOrder={RENDER_ORDER_HIGHLIGHT} raycast={NO_RAYCAST}>
          <lineBasicMaterial color={COLOR_HOVER} depthTest={false} transparent />
        </lineSegments>
      )}
      {selVerts && (
        <points geometry={selVerts} renderOrder={RENDER_ORDER_HIGHLIGHT} raycast={NO_RAYCAST}>
          <pointsMaterial color={COLOR_SELECTED} size={9} sizeAttenuation={false} depthTest={false} transparent />
        </points>
      )}
      {hovVerts && (
        <points geometry={hovVerts} renderOrder={RENDER_ORDER_HIGHLIGHT} raycast={NO_RAYCAST}>
          <pointsMaterial color={COLOR_HOVER} size={9} sizeAttenuation={false} depthTest={false} transparent />
        </points>
      )}
    </group>
  )
}
