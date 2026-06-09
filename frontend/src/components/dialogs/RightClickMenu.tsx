import { useEffect, useRef } from 'react'
import '@/components/dialogs/RightClickMenu.css'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  icon?: string
  className?: string
}

interface RightClickMenuProps {
  items: ContextMenuItem[]
  position: [number, number]
  onClose: () => void
}

export default function RightClickMenu({ items, position, onClose }: RightClickMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', close, { capture: true })
    return () => window.removeEventListener('mousedown', close, { capture: true })
  }, [onClose])

  const [x, y] = position

  return (
    <div
      ref={menuRef}
      className="right-click-menu"
      style={{ left: x, top: y }}
      onMouseDown={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div
          key={`${item.label}-${i}`}
          className={`right-click-menu-item ${item.className || ''}`}
          onClick={() => {
            item.onClick()
            onClose()
          }}
        >
          {item.icon && (
            <img src={item.icon} alt="" className="right-click-menu-icon" />
          )}
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  )
}
