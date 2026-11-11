import { useSyncExternalStore } from 'react'
import { Spinner } from '@/components/shared/Spinner'
import {
  getOccLoadProgress,
  occLoadPercent,
  subscribeOccLoadProgress,
} from '@/kernel/occ/loadProgress'
import { useKernelReady } from '@/kernel/worker/kernelReady'
import './SplashScreen.css'

// Flip to true to keep the splash mounted regardless of kernel readiness, so
// the splash can be styled and iterated on without waiting for (or mocking)
// the kernel load. Leave false in shipped builds.
export const SPLASH_DEBUG_HOLD = false

interface SplashScreenProps {
  debugHold?: boolean
}

export default function SplashScreen({ debugHold = SPLASH_DEBUG_HOLD }: SplashScreenProps) {
  const ready = useKernelReady()
  const held = debugHold || SPLASH_DEBUG_HOLD
  const occLoad = useSyncExternalStore(subscribeOccLoadProgress, getOccLoadProgress)

  if (ready && !held) return null

  const percent = occLoadPercent(occLoad)
  const kernelStatus =
    occLoad.phase === 'idle'
      ? 'Loading solvers...'
      : occLoad.phase === 'downloading'
        ? percent === null
          ? 'Loading geometry kernel'
          : `Loading geometry kernel ${percent}%`
        : occLoad.phase === 'compiling'
          ? 'Compiling geometry kernel'
          : 'Loading solvers...'

  return (
    <div className="splash-screen" data-testid="splash-screen" role="status">
      <div className="splash-screen-content">
        <h1 className="splash-screen-title">Oversolved</h1>
        <div className="md3-spinner-container">
          <div className="md3-spinner-rotator">
            <Spinner className="md3-spinner-svg" circleClassName="md3-spinner-path" />
          </div>
        </div>
        <p className="splash-screen-status">{kernelStatus}</p>
      </div>
    </div>
  )
}
