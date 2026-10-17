import { Line } from '@react-three/drei'
import type { ThreadCurve } from './threadHelices'

// The cosmetic-thread helices of every threaded hole in the scene, drawn as
// plain polylines: the standard representation of a thread without modelling
// its flank. Display only: a thread is metadata on its hole, not a pickable
// reference of its own.
export default function ThreadCurves({ curves }: { curves: readonly ThreadCurve[] }) {
  if (curves.length === 0) return null
  return (
    <group>
      {curves.map((curve, i) => (
        <Line key={`${curve.featureId}:${i}`} points={curve.points} color="#7a5cff" lineWidth={1} />
      ))}
    </group>
  )
}
