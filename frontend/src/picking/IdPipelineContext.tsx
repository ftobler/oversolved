import { createContext, useContext, useEffect, useState } from 'react'
import type { IdPipeline } from './IdPipeline'
import { failLoud } from '@/utils/invariants'

/**
 * Live IdPipeline accessor.
 *
 * The pipeline is created inside the R3F Canvas by <IdPickingDriver>, but
 * is consumed both by Canvas children (for geometry registration) and by
 * outer-tree code (Viewport pointer dispatch). A module-level ref + subscribe
 * pattern gives both sides access without forcing all Canvas children to
 * live inside the Driver's React subtree.
 *
 * The React context is still exported for tests that want to inject a stub.
 */

let currentPipeline: IdPipeline | null = null
const listeners = new Set<() => void>()

/**
 * Set the live pipeline. Pass `expectedPrevious` to make the write
 * conditional: the swap only happens if the current value matches.
 * Use this from cleanup paths so a StrictMode remount whose new mount
 * already overwrote the global isn't clobbered by the old mount's
 * teardown.
 */
export function setLivePipeline(p: IdPipeline | null, expectedPrevious?: IdPipeline | null): void {
  // A disposed pipeline is permanently deaf on the async resolve path, so
  // republishing one (the Suspense hide/reveal "cleanup then setup" cycle)
  // silently kills hover + click picking. The lifecycle hook is what makes this
  // unreachable; this is the loud canary that proves it.
  if (p && p.isDisposed()) {
    failLoud('[invariant] setLivePipeline refused a disposed IdPipeline; the lifecycle must mint a fresh instance')
    return
  }
  if (expectedPrevious !== undefined && currentPipeline !== expectedPrevious) return
  currentPipeline = p
  for (const l of listeners) l()
}

export function getLivePipeline(): IdPipeline | null {
  return currentPipeline
}

export const IdPipelineContext = createContext<IdPipeline | null>(null)

export function useIdPipeline(): IdPipeline | null {
  const fromContext = useContext(IdPipelineContext)
  const [live, setLive] = useState<IdPipeline | null>(currentPipeline)

  useEffect(() => {
    const sub = () => setLive(currentPipeline)
    listeners.add(sub)
    sub()
    return () => { listeners.delete(sub) }
  }, [])

  return fromContext ?? live
}
