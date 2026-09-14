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
  // The element focused when the menu opened, so Escape and a selection hand
  // focus back to it instead of dropping it to the body.
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null
    // A menu has to work without a mouse: focus the first item on open so the
    // arrow keys and Enter can reach the rest.
    menuRef.current?.querySelector<HTMLElement>('.right-click-menu-item')?.focus()
    const restore = returnFocusRef.current
    return () => {
      if (restore?.isConnected) restore.focus()
    }
  }, [])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const nodes = [...(menuRef.current?.querySelectorAll<HTMLElement>('.right-click-menu-item') ?? [])]
      if (nodes.length === 0) return
      e.preventDefault()
      const index = nodes.indexOf(document.activeElement as HTMLElement)
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next = index === -1 ? 0 : (index + step + nodes.length) % nodes.length
      nodes[next].focus()
    }
    window.addEventListener('mousedown', close, { capture: true })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', close, { capture: true })
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const [x, y] = position

  return (
    <div
      ref={menuRef}
      className="right-click-menu"
      role="menu"
      style={{ left: x, top: y }}
      onMouseDown={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {items.map((item, i) => (
        // A real button, so the item is tabbable, Enter and Space activate it,
        // and a screen reader announces it as a menu item rather than plain text.
        <button
          type="button"
          role="menuitem"
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
        </button>
      ))}
    </div>
  )
}
