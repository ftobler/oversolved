interface RebuildSparklineProps {
  durations: number[]
}

export function RebuildSparkline({ durations }: RebuildSparklineProps) {
  if (durations.length === 0) return null

  const max = Math.max(...durations)
  const min = Math.min(...durations)
  const range = max - min || 1

  const divisor = Math.max(durations.length - 1, 1)

  const points = durations.map((d, i) => {
    const x = (i / divisor) * 200
    const y = 30 - ((d - min) / range) * 30
    return `${x},${y}`
  }).join(' ')

  const avg = durations.reduce((a, b) => a + b, 0) / durations.length
  const avgY = 30 - ((avg - min) / range) * 30

  return (
    <svg width="220" height="40" viewBox="0 0 220 40" className="rebuild-sparkline">
      <line
        x1="0"
        y1={avgY}
        x2="200"
        y2={avgY}
        stroke="#ccc"
        strokeDasharray="2,2"
        strokeWidth="1"
      />
      <polyline
        points={points}
        fill="none"
        stroke="#4f46e5"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      {durations.map((d, i) => {
        const x = (i / divisor) * 200
        const y = 30 - ((d - min) / range) * 30
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r="1.5"
            fill="#4f46e5"
          />
        )
      })}
    </svg>
  )
}
