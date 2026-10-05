import { iconModules } from '@/utils/core/iconModules'

function iconUrl(filename: string | undefined): string | undefined {
  if (!filename) return undefined
  return iconModules[`/src/assets/icons/${filename}.svg`]
    ?? iconModules[`../assets/icons/${filename}.svg`]
}

export function Icon({ file, size = 18 }: { file: string | undefined; size?: number }) {
  const url = iconUrl(file)
  if (!url) return <span className="reg-no-icon">-</span>
  return <img src={url} width={size} height={size} className="reg-icon" alt={file} />
}

export function Badge({ text, variant }: { text: string; variant: 'geo' | 'dim' | 'yes' | 'no' | 'neutral' }) {
  return <span className={`reg-badge reg-badge--${variant}`}>{text}</span>
}
