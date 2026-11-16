import { useRef, useState } from 'react'
import type { Mutation } from '@/types/cad'
import type { SelectFieldWidgetProps } from './fieldTypes'

export type TabsFieldProps = SelectFieldWidgetProps

export function TabsField({
  field, value, data, fid, onMutation, mutationType,
}: TabsFieldProps) {
  const shown = field.valueFrom ? field.valueFrom(data) : (value ?? field.default ?? field.options[0].value)
  const options = field.options
  const [focusIndex, setFocusIndex] = useState(() => {
    const idx = options.findIndex((o) => o.value === shown)
    return idx >= 0 ? idx : 0
  })
  const [prevShown, setPrevShown] = useState(shown)
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([])

  if (prevShown !== shown) {
    setPrevShown(shown)
    const idx = options.findIndex((o) => o.value === shown)
    setFocusIndex(idx >= 0 ? idx : 0)
  }

  const selectValue = (val: string) => {
    const write = field.getMutation
      ? field.getMutation(val, data)
      : { field: field.key, value: val }
    onMutation({ type: mutationType, featureId: fid, field: write.field, value: write.value } as Mutation)
  }

  const move = (next: number, current: number) => {
    if (next === current) return
    setFocusIndex(next)
    buttonsRef.current[next]?.focus()
    selectValue(options[next].value)
  }

  return (
    <div
      className="feature-field-tabs"
      role="tablist"
      aria-label={field.label}
      onClick={(e) => e.stopPropagation()}
    >
      {options.map((o, i) => {
        const active = o.value === shown
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={i === focusIndex ? 0 : -1}
            title={o.label}
            className={`feature-field-tab${active ? ' active' : ''}`}
            ref={(el) => { buttonsRef.current[i] = el }}
            onClick={(e) => {
              e.stopPropagation()
              if (o.value === shown) return
              setFocusIndex(i)
              selectValue(o.value)
            }}
            onFocus={() => setFocusIndex(i)}
            onKeyDown={(e) => {
              let next = i
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(options.length - 1, i + 1)
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, i - 1)
              else if (e.key === 'Home') next = 0
              else if (e.key === 'End') next = options.length - 1
              else return
              e.preventDefault()
              e.stopPropagation()
              move(next, i)
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}


