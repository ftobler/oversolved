// Registers the assembly scene's face/edge/vertex ID layers. The part editor
// does this from Body3D, keyed by ancestry query strings; an assembly has none,
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
import type { AssemblyPickBody } from '@/utils/assemblyPick'

function unregisterAll(pipeline: IdPipeline, registered: Map<string, AssemblyPickBody>): void {
  for (const bodyKey of registered.keys()) {
    pipeline.faceLayer.unregisterBody(bodyKey)
    pipeline.edgeLayer.unregisterBody(bodyKey)
    pipeline.vertexLayer.unregisterBody(bodyKey)
  }
  registered.clear()
}

export default function AssemblyPickLayers({ bodies }: { bodies: AssemblyPickBody[] }) {
  const pipeline = useIdPipeline()
  // The body objects currently registered, keyed by bodyKey. A body whose
  // object identity is unchanged needs no re-registration.
  const registeredRef = useRef<Map<string, AssemblyPickBody>>(new Map())

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
    const next = new Set(bodies.map(body => body.bodyKey))
    let changed = false

    // Drop bodies that left the snapshot.
    for (const bodyKey of [...registered.keys()]) {
      if (next.has(bodyKey)) continue
      pipeline.faceLayer.unregisterBody(bodyKey)
      pipeline.edgeLayer.unregisterBody(bodyKey)
      pipeline.vertexLayer.unregisterBody(bodyKey)
      registered.delete(bodyKey)
      changed = true
    }

    // Register new and moved bodies; unchanged ones keep their GPU resources.
    // Each layer's registerBody pre-clears its own key, so a replaced body is
    // dropped before the new geometry lands.
    for (const body of bodies) {
      if (registered.get(body.bodyKey) === body) continue
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
        registered.set(bodyKey, body)
      } catch (err) {
        // One malformed body must not cost the whole assembly its picking. Drop
        // it from the bookkeeping so the next tick retries it.
        registered.delete(bodyKey)
        console.warn('Assembly ID registration failed for a body', { bodyKey, err })
      }
      changed = true
    }

    if (changed) pipeline.markDirty('assembly-pick-geometry')
  }, [pipeline, bodies])

  return null
}
