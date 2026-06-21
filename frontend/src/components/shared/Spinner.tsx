interface SpinnerProps {
  className?: string
  circleClassName?: string
}

export function Spinner({ className = '', circleClassName }: SpinnerProps) {
  return (
    <svg className={className} viewBox="0 0 48 48">
      <circle
        className={circleClassName}
        cx="24"
        cy="24"
        r="18"
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}
