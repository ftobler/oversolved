// Registers the assembly scene's face/edge/vertex ID layers. The part editor
// does this from Part3D, keyed by ancestry query strings; an assembly has none,
// so the keys are the bundle's positional entity ids (`assemblyEntityKey`) and
// the payloads are pre-computed in utils/assemblyPick.ts. This component only
// carries them across the pipeline boundary.
//
// During a settle the drawn pick geometry is re-derived every tick, but only
// the bodies that actually moved get new objects (offsetPickBodies returns the
// rest by reference). The effect diffs on body identity and bodyKey so a tick
// re-registers only those moved bodies, not the whole scene.
//
// Renders nothing. It is a component rather than a hook so the registration's
// lifetime is the scene's: unmounting the viewport frees the ids.

import { useEffect, useRef } from 'react'
import { useIdPipeline, type IdPipeline } from '@/picking'
import { isDevBuild } from '@/kernel/isDevBuild'
import {
  pickEdgesForRegistration,
  pickVerticesForRegistration,
  type AssemblyPickPart,
} from '@/utils/assemblyPick'

function unregisterAll(pipeline: IdPipeline, registered: Map<string, AssemblyPickPart>): void {
  for (const partKey of registered.keys()) {
    pipeline.faceLayer.unregisterPart(partKey)
    pipeline.edgeLayer.unregisterPart(partKey)
    pipeline.vertexLayer.unregisterPart(partKey)
  }
  registered.clear()
}

/** Which drawn layers were registered, so a viewer toggle can re-register. */
function layerKey(showFaces: boolean, showEdges: boolean): string {
  return `${showFaces ? 'f' : ''}${showEdges ? 'e' : ''}`
}

export default function AssemblyPickLayers({ parts, showFaces = true, showEdges = true }: {
  parts: AssemblyPickPart[]
  showFaces?: boolean
  showEdges?: boolean
}) {
  const pipeline = useIdPipeline()
  // The body objects currently registered, keyed by bodyKey. A body whose
  // object identity is unchanged needs no re-registration.
  const registeredRef = useRef<Map<string, AssemblyPickPart>>(new Map())
  const layersRef = useRef(layerKey(showFaces, showEdges))

  // Unmount / pipeline swap frees every id this component registered. Kept
  // apart from the registration effect so a bodies change never tears the whole
  // scene down and rebuilds it.
  useEffect(() => {
    if (!pipeline) return
    const registered = registeredRef.current
    return () => {
      unregisterAll(pipeline, registered)
      pipeline.markDirty('assembly-pick-geometry')
    }
  }, [pipeline])

  useEffect(() => {
    if (!pipeline) return
    const registered = registeredRef.current
    const next = new Set(parts.map(part => part.partKey))
    let changed = false

    // A viewer layer toggle changes which layers exist, not the bodies. The
    // simplest honest answer is to drop every registration and rebuild: the
    // shutter is a rare click, and the alternative -- tracking a per-layer
    // registration set -- would be bookkeeping with no runtime gain. A layer
    // that is off is not in the ID buffer at all, matching what is drawn.
    const key = layerKey(showFaces, showEdges)
    if (layersRef.current !== key) {
      unregisterAll(pipeline, registered)
      layersRef.current = key
      changed = true
    }

    // Drop bodies that left the snapshot.
    for (const partKey of [...registered.keys()]) {
      if (next.has(partKey)) continue
      pipeline.faceLayer.unregisterPart(partKey)
      pipeline.edgeLayer.unregisterPart(partKey)
      pipeline.vertexLayer.unregisterPart(partKey)
      registered.delete(partKey)
      changed = true
    }

    // Register new and moved bodies; unchanged ones keep their GPU resources.
    // Each layer's registerBody pre-clears its own key, so a replaced body is
    // dropped before the new geometry lands.
    for (const part of parts) {
      if (registered.get(part.partKey) === part) continue
      const { partKey } = part
      try {
        if (showFaces && part.faces) {
          pipeline.faceLayer.registerPart({ partKey: partKey, ...part.faces })
        }
        // The bundle's sparse seam lists apply here only: `body.edges` and
        // `body.vertices` stay whole for the selection overlay, so a seam an
        // authored mate names still highlights from the tree.
        const edges = pickEdgesForRegistration(part.edges, part.hiddenEdges)
        if (showEdges && edges) {
          pipeline.edgeLayer.registerPart({ partKey: partKey, ...edges })
        }
        const vertices = pickVerticesForRegistration(part.vertices, part.hiddenVertices)
        if (vertices) {
          pipeline.vertexLayer.registerPart({
            partKey: partKey,
            vertices: vertices.vertices,
            vertexQueries: vertices.vertexQueries,
          })
        }
        registered.set(partKey, part)
      } catch (err) {
        // One malformed body must not cost the whole assembly its picking. A
        // layer that registered before the throw has to release its ids here:
        // the bookkeeping below drops the body, so the next cleanup -- which
        // walks `registered` -- would never see it again and its face/vertex
        // meshes would live until the pipeline is disposed.
        pipeline.faceLayer.unregisterPart(partKey)
        pipeline.edgeLayer.unregisterPart(partKey)
        pipeline.vertexLayer.unregisterPart(partKey)
        registered.delete(partKey)
        if (isDevBuild()) console.warn('Assembly ID registration failed for a body', { bodyKey: partKey, err })
      }
      changed = true
    }

    if (changed) pipeline.markDirty('assembly-pick-geometry')
  }, [pipeline, parts, showFaces, showEdges])

  return null
}
