// Registers the assembly scene's face/edge/vertex ID layers. The part editor
// does this from Body3D, keyed by ancestry query strings; an assembly has none,
// so the keys are the bundle's positional entity ids (`assemblyEntityKey`) and
// the payloads are pre-computed in utils/assemblyPick.ts. This component only
// carries them across the pipeline boundary.
//
// Renders nothing. It is a component rather than a hook so the registration's
// lifetime is the scene's: unmounting the viewport frees the ids.

import { useEffect } from 'react'
import { useIdPipeline } from '@/picking'
import type { AssemblyPickBody } from '@/utils/assemblyPick'

export default function AssemblyPickLayers({ bodies }: { bodies: AssemblyPickBody[] }) {
  const pipeline = useIdPipeline()

  useEffect(() => {
    if (!pipeline || bodies.length === 0) return
    for (const body of bodies) {
      const { bodyKey } = body
      try {
        if (body.faces) {
          pipeline.faceLayer.registerBody({ bodyKey, ...body.faces })
        }
        if (body.edges) {
          pipeline.edgeLayer.registerBody({ bodyKey, ...body.edges })
        }
        if (body.vertices) {
          pipeline.vertexLayer.registerBody({ bodyKey, ...body.vertices })
        }
      } catch (err) {
        // One malformed body must not cost the whole assembly its picking.
        console.warn('Assembly ID registration failed for a body', { bodyKey, err })
      }
    }
    pipeline.markDirty('assembly-pick-geometry')

    return () => {
      for (const body of bodies) {
        pipeline.faceLayer.unregisterBody(body.bodyKey)
        pipeline.edgeLayer.unregisterBody(body.bodyKey)
        pipeline.vertexLayer.unregisterBody(body.bodyKey)
      }
      pipeline.markDirty('assembly-pick-geometry')
    }
  }, [pipeline, bodies])

  return null
}
