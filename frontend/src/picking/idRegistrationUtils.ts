import { useEffect } from 'react'
import * as THREE from 'three'
import type { PlaneTransform } from '@/types/cad'
import type { IdPipeline } from './IdPipeline'

export function buildPlaneMatrix(planeTransform?: PlaneTransform): THREE.Matrix4 {
  const m = new THREE.Matrix4()
  if (!planeTransform) return m
  const [x0, x1, x2, y0, y1, y2, n0, n1, n2] = planeTransform.rotation
  m.set(
    x0, y0, n0, 0,
    x1, y1, n1, 0,
    x2, y2, n2, 0,
    0,  0,  0,  1,
  )
  const o = planeTransform.origin
  m.setPosition(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0)
  return m
}

/**
 * Shared lifecycle for ID-layer registration hooks. Handles the pipeline
 * guard, markDirty calls, and cleanup so individual hooks only supply the
 * layer-specific register/unregister logic. Returns false from `register`
 * to abort (skip markDirty) when registration itself fails.
 */
export function useRegisteredBody(
  pipeline: IdPipeline | null,
  enabled: boolean,
  bodyKey: string,
  register: (p: IdPipeline) => boolean,
  unregister: (p: IdPipeline) => void,
  deps: unknown[],
): void {
  useEffect(() => {
    if (!enabled || !pipeline) return
    const ok = register(pipeline)
    if (!ok) return
    pipeline.markDirty('registration')
    return () => {
      unregister(pipeline)
      pipeline.markDirty()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline, enabled, bodyKey, ...deps])
}
