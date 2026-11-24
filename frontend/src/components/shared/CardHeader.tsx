import type { ReactNode } from 'react'
import '@/components/layout/CardHeader.css'

export interface CardHeaderProps {
  icon: string
  // Decorative by default: the title names the subject, and a caller whose
  // icon carries meaning of its own passes an alt.
  iconAlt?: string
  title: string
  // A card that reads its title differently (the section card keeps its grey)
  // adds its own class on top of the shared one.
  titleClassName?: string
  actions?: ReactNode
}

/**
 * The one header row every floating card shares: the tinted 20px icon, the
 * ellipsised title, and the card's own buttons at the right. The feature,
 * assembly, section and bug report cards each grew their own copy of this
 * markup; they differ only in the icon and the actions, which are props here.
 *
 * The row's layout lives in components/layout/CardHeader.css. The icon tint and
 * the verdict buttons stay in Glass.css beside it, because the tree rows and
 * the context menu share those too and they are not card-only.
 */
export function CardHeader({
  icon,
  iconAlt = '',
  title,
  titleClassName,
  actions,
}: CardHeaderProps) {
  return (
    <div className="card-header">
      <img className="feature-icon" src={icon} alt={iconAlt} />
      <span className={titleClassName ? `card-header-title ${titleClassName}` : 'card-header-title'}>
        {title}
      </span>
      {actions}
    </div>
  )
}
