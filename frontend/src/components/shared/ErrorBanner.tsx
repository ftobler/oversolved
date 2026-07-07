import './ErrorBanner.css'

interface ErrorBannerProps {
  message: string
  onDismiss: () => void
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="error-banner-overlay">
      <div className="error-banner-box">
        <span className="material-icons error-banner-icon">error</span>
        <span className="error-banner-message">{message}</span>
        <button className="error-banner-close" onClick={onDismiss} title="Dismiss">
          <span className="material-icons">close</span>
        </button>
      </div>
    </div>
  )
}
